import Cocoa
import Foundation
import Vision

private final class AmbientObserverCallback: @unchecked Sendable {
    let call: (AmbientObservationSnapshot?) -> Void
    init(_ call: @escaping (AmbientObservationSnapshot?) -> Void) { self.call = call }
}

extension AppState {
    func startAmbientObserver() {
        guard ambientObserverTimer == nil else { return }
        ambientObserverTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
            self?.refreshInbox(.lifecycle)
        }
    }

    func refreshAmbientObservations(completion: ((Bool) -> Void)? = nil) {
        if let completion { ambientRefreshCallbacks.append(DesktopRefreshCallback(completion)) }
        if isAmbientObserverRunning {
            ambientRefreshQueued = true
            return
        }
        guard isConnected,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            finishAmbientRefresh(succeeded: false)
            return
        }
        isAmbientObserverRunning = true
        ambientObserverError = nil
        let nowMs = Date().timeIntervalSince1970 * 1000
        let retentionStart = nowMs - 14 * 24 * 60 * 60 * 1000
        let rollingOverlapStart =
            ambientObservationSnapshot.flatMap {
                $0.engineVersion == AmbientObservationSnapshot.currentEngineVersion
                    ? $0.generatedAt - 5 * 60 * 1000 : nil
            } ?? retentionStart
        // A response can arrive hours or days after the message that opened an
        // observation. Keep every unresolved event inside the next scan window;
        // otherwise a five-minute incremental scan can never transition it to
        // `received` and the stale card survives indefinitely.
        let oldestUnresolvedStart = ambientObservationSnapshot?.candidates
            .filter { $0.responseState != "received" }
            .map(\.startedAt)
            .min()
        let overlapStart = max(
            min(rollingOverlapStart, oldestUnresolvedStart ?? rollingOverlapStart),
            retentionStart)
        let callback = AmbientObserverCallback { [weak self] incoming in
            guard let self else { return }
            self.isAmbientObserverRunning = false
            guard var incoming else {
                self.ambientObserverError = self.i18n.t("ambient_observer_failed")
                self.finishAmbientRefresh(succeeded: false)
                return
            }
            incoming = self.mergeAmbientObservationSnapshot(incoming)
            self.ambientObservationSnapshot = incoming
            self.workItems = incoming.workItems
            AmbientObservationStore.save(incoming)
            self.queueObservationOCR(incoming)
            if self.ambientRefreshQueued {
                self.ambientRefreshQueued = false
                self.refreshAmbientObservations()
            } else {
                self.finishAmbientRefresh(succeeded: true)
            }
        }
        DispatchQueue.global(qos: .utility).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.arguments = [paths.runMjs, "ambient-observe", String(Int(overlapStart))]
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try DesktopBridgeRunner.start(process)
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 60) {
                    if DesktopBridgeRunner.isRunning(process) { DesktopBridgeRunner.terminate(process) }
                }
                let data = DesktopBridgeRunner.read(output)
                DesktopBridgeRunner.wait(process)
                let snapshot =
                    DesktopBridgeRunner.status(process) == 0
                    ? AmbientObservationStore.decodeBridge(data) : nil
                DispatchQueue.main.async { callback.call(snapshot) }
            } catch {
                DispatchQueue.main.async { callback.call(nil) }
            }
        }
    }

    private func finishAmbientRefresh(succeeded: Bool) {
        let callbacks = ambientRefreshCallbacks
        ambientRefreshCallbacks.removeAll()
        for callback in callbacks { callback.call(succeeded) }
    }

    private func mergeAmbientObservationSnapshot(
        _ incoming: AmbientObservationSnapshot
    ) -> AmbientObservationSnapshot {
        guard let previous = ambientObservationSnapshot,
            previous.engineVersion == incoming.engineVersion
        else { return incoming }
        let previousByID = Dictionary(uniqueKeysWithValues: previous.candidates.map { ($0.id, $0) })
        var changed = previous.candidates.count != incoming.candidates.count
        var merged = incoming.candidates.map { candidate -> AmbientObservationCandidate in
            guard let old = previousByID[candidate.id] else {
                changed = true
                var value = candidate
                value.changeReason = "new_candidate"
                return value
            }
            let oldOCR = Dictionary(
                uniqueKeysWithValues: old.evidence.compactMap { evidence in
                    evidence.ocrText.map { text in (evidence.id, text) }
                })
            let attemptedOCR = Set(
                old.evidence.filter { $0.ocrAttempted == true }.map(\.id))
            var value = candidate
            value.evidence = value.evidence.map { evidence in
                var next = evidence
                next.ocrText = oldOCR[evidence.id]
                next.ocrAttempted = attemptedOCR.contains(evidence.id)
                return next
            }
            if old.status != value.status {
                changed = true
                value.changeReason = "status_changed"
            } else if old.evidence.map(\.id) != value.evidence.map(\.id) {
                changed = true
                value.changeReason = "evidence_changed"
            } else {
                value.changeReason = old.changeReason
            }
            return value
        }
        let incomingIDs = Set(incoming.candidates.map(\.id))
        let retentionStart = incoming.generatedAt - 14 * 24 * 60 * 60 * 1000
        if incoming.windowStart > previous.windowStart {
            merged.append(
                contentsOf: previous.candidates.filter {
                    !incomingIDs.contains($0.id)
                        && ($0.responseState != "received" || $0.updatedAt >= retentionStart)
                })
        }
        merged.sort { $0.updatedAt > $1.updatedAt }
        var result = incoming
        let collectionChanged = merged.map(\.id) != previous.candidates.map(\.id)
        result.version = (changed || collectionChanged) ? previous.version + 1 : previous.version
        result.windowStart = min(previous.windowStart, incoming.windowStart)
        let unresolved = merged.filter { $0.responseState != "received" }
        let recentResolved = merged.filter { $0.responseState == "received" }
        result.candidates = Array(unresolved.prefix(100)) + Array(recentResolved.prefix(24))
        // Work Items are already idempotently upserted by the shared Node
        // pipeline. Keep the latest projection while retaining old rows when
        // an incremental ambient window does not include them.
        let incomingWorkItemIDs = Set(incoming.workItems.map(\.id))
        result.workItems =
            incoming.workItems
            + previous.workItems.filter {
                !incomingWorkItemIDs.contains($0.id)
                    && ($0.resolutionState != "resolved" || $0.updatedAt >= retentionStart)
            }
        return result
    }

    private func queueObservationOCR(_ snapshot: AmbientObservationSnapshot) {
        let items = snapshot.candidates.flatMap { candidate in
            candidate.evidence.compactMap { evidence -> (String, String, String, String?)? in
                guard ["image", "sticker"].contains(evidence.mediaType ?? ""),
                    evidence.ocrEligible, evidence.ocrAttempted != true
                else { return nil }
                return (candidate.id, evidence.chatId, evidence.messageId, evidence.sourceUrl)
            }
        }
        for item in items.prefix(12) {
            let key = "\(item.1):\(item.2)"
            guard !ambientObserverOCRQueued.contains(key) else { continue }
            ambientObserverOCRQueued.insert(key)
            ambientObserverOCRQueue.async { [weak self] in
                guard let self else { return }
                let text = self.recognizeObservationImage(
                    chatId: item.1, messageId: item.2, sourceUrl: item.3)
                DispatchQueue.main.async {
                    self.ambientObserverOCRQueued.remove(key)
                    guard var report = self.ambientObservationSnapshot,
                        let candidateIndex = report.candidates.firstIndex(where: { $0.id == item.0 }),
                        let evidenceIndex = report.candidates[candidateIndex].evidence.firstIndex(where: { $0.id == item.2 })
                    else { return }
                    report.candidates[candidateIndex].evidence[evidenceIndex].ocrAttempted = true
                    if let text, !text.isEmpty {
                        report.candidates[candidateIndex].evidence[evidenceIndex].ocrText = text
                    }
                    if let text, report.candidates[candidateIndex].title.isEmpty {
                        report.candidates[candidateIndex].title = String(text.prefix(72))
                    }
                    self.ambientObservationSnapshot = report
                    AmbientObservationStore.save(report)
                }
            }
        }
    }

    private nonisolated func recognizeObservationImage(
        chatId: String, messageId: String, sourceUrl: String?
    ) -> String? {
        let image: NSImage?
        if let sourceUrl, let url = URL(string: sourceUrl),
            let data = try? Data(contentsOf: url)
        {
            image = NSImage(data: data)
        } else {
            guard let nodePath = YomiPathResolver.findNodePath(),
                let paths = YomiPathResolver.findRunMjs()
            else { return nil }
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.arguments = [paths.runMjs, "media-preview", chatId, messageId, "--file-output"]
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do { try DesktopBridgeRunner.start(process) } catch { return nil }
            let data = DesktopBridgeRunner.read(output)
            DesktopBridgeRunner.wait(process)
            guard DesktopBridgeRunner.status(process) == 0,
                let payload = try? JSONDecoder().decode(MediaPreviewPayload.self, from: data),
                let filePath = payload.filePath
            else { return nil }
            image = NSImage(contentsOfFile: filePath)
            try? FileManager.default.removeItem(
                at: URL(fileURLWithPath: filePath).deletingLastPathComponent())
        }
        guard let image,
            let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hant", "en-US"]
        request.usesLanguageCorrection = true
        do { try VNImageRequestHandler(cgImage: cgImage).perform([request]) } catch { return nil }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
