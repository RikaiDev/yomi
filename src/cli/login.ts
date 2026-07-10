/**
 * Shared LINE passwordless-login core, plus the TTY front-end for it.
 *
 * `runPwlessLogin` is the ONE login sequence: subscribe to `pinCreated`/
 * `waitingForBiometric`, drive `service.startPwlessLogin`, unsubscribe in a
 * `finally`, and persist the phone/region that succeeded. Every front-end
 * calls it — the MCP `login`/`login_complete` tools (see
 * ../mcp/handlers-login.ts; surfaces the PIN via elicitation on clients
 * that support it, or as a tool-result string with a follow-up
 * `login_complete` call on clients that don't) and `cliLogin` below
 * (surfaces the PIN on stdout, for the guaranteed-to-work `bun run.mjs
 * login` path that needs no MCP client at all). No front-end duplicates
 * the sequence itself.
 */

import readline from 'node:readline/promises';
import { LineProtocolService } from '../line/core/service.js';

/** Result of a successful passwordless login. */
export interface PwlessLoginResult {
  mid: string | null;
  displayName: string | null;
}

/** Front-end hooks into the shared login sequence. */
export interface PwlessLoginHooks {
  /** Called the moment LINE issues the PIN the human must enter. */
  onPin: (pin: string) => void;
  /** Called once the flow starts waiting on phone biometric approval. */
  onWaitingBiometric?: () => void;
}

/**
 * Drive the passwordless (secondary-device) LINE login flow to completion.
 *
 * This is the single login sequence shared by every front-end — do not
 * re-subscribe to `pinCreated`/`waitingForBiometric` or call
 * `service.startPwlessLogin` anywhere else.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param phone - Phone number in E.164 form.
 * @param region - Region code (e.g. TW, JP).
 * @param hooks - Front-end callbacks for surfacing the PIN/biometric wait.
 * @returns The resulting profile identity.
 */
export async function runPwlessLogin(
  service: LineProtocolService,
  phone: string,
  region: string,
  hooks: PwlessLoginHooks,
): Promise<PwlessLoginResult> {
  const onBiometric = () => hooks.onWaitingBiometric?.();
  service.on('pinCreated', hooks.onPin);
  service.on('waitingForBiometric', onBiometric);
  try {
    await service.startPwlessLogin(phone, region);
    const profile = service.profile ?? null;
    // Persist phone/region once, here in the shared core, so every
    // front-end's next login is argument-free (and the phone number stops
    // appearing in the tool-call transcript).
    await service.credentialStore?.set?.('line_phone', phone);
    await service.credentialStore?.set?.('line_region', region);
    return { mid: profile?.mid ?? null, displayName: profile?.displayName ?? null };
  }
  finally {
    service.off('pinCreated', hooks.onPin);
    service.off('waitingForBiometric', onBiometric);
  }
}

/**
 * Prompt on stdin for a value when it was not supplied on the command line.
 *
 * @param rl - Open readline interface.
 * @param label - Prompt label.
 * @returns Trimmed user input.
 */
async function promptFor(rl: readline.Interface, label: string): Promise<string> {
  const answer = await rl.question(`${label}: `);
  return answer.trim();
}

/**
 * Parse `--phone`/`--region` flags out of CLI args.
 *
 * @param argv - Arguments following `login`.
 * @returns Parsed phone/region (undefined when not supplied).
 */
function parseLoginArgs(argv: string[]): { phone?: string; region?: string } {
  let phone: string | undefined;
  let region: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phone') {
      phone = argv[i + 1];
      i++;
    }
    else if (argv[i] === '--region') {
      region = argv[i + 1];
      i++;
    }
  }
  return { phone, region };
}

/**
 * TTY front-end: `bun run.mjs login [--phone +886...] [--region TW]`.
 *
 * Prints the PIN prominently to stdout (not stderr — there is no MCP
 * client here to hide it from). Falls back to a previously persisted
 * `line_phone`/`line_region` when the corresponding flag is absent, and
 * only prompts on stdin for whatever is still missing after that. Blocks
 * until the flow completes.
 *
 * @param argv - Arguments following `login` on the command line.
 * @returns Process exit code (0 on success).
 */
export async function cliLogin(argv: string[]): Promise<number> {
  const parsed = parseLoginArgs(argv);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const service = new LineProtocolService();
  // A Node EventEmitter with zero 'error' listeners turns any emit('error')
  // into an uncaught exception that kills this process (see pwless-login-flow.ts,
  // auth-session-service.ts). This listener must exist for the lifetime of the
  // service so a login/session error surfaces as a log line, not a crash — the
  // real failure still reaches this function through the normal throw/rejection path.
  service.on('error', (error: any) => console.error(`[Yomi] service error: ${error?.message ?? String(error)}`));
  try {
    const phone = parsed.phone
      || (await service.credentialStore?.get?.('line_phone'))
      || await promptFor(rl, 'LINE phone number (E.164, e.g. +8869XXXXXXXX)');
    const region = parsed.region
      || (await service.credentialStore?.get?.('line_region'))
      || await promptFor(rl, 'Region code (e.g. TW, JP, TH, ID, US)');
    if (!phone || !region) {
      console.error('[Yomi] phone and region are required.');
      return 1;
    }

    console.log('[Yomi] Starting passwordless login. Enter the PIN on your primary phone within '
      + 'about 3 minutes of it appearing — that is LINE\'s own deadline; this CLI itself will keep '
      + 'waiting well beyond that.');

    const result = await runPwlessLogin(service, phone, region, {
      onPin: (pin) => {
        console.log(`[Yomi] PIN: ${pin}`);
        console.log('[Yomi] Enter this PIN in the LINE app on your primary phone, then approve the new device.');
      },
      onWaitingBiometric: () => {
        console.log('[Yomi] Waiting for you to approve the new device on your phone...');
      },
    });

    console.log(`[Yomi] Login successful. mid=${result.mid ?? 'unknown'} displayName=${result.displayName ?? 'unknown'}`);
    return 0;
  }
  catch (error: any) {
    console.error(`[Yomi] Login failed: ${error?.message ?? String(error)}`);
    return 1;
  }
  finally {
    rl.close();
  }
}
