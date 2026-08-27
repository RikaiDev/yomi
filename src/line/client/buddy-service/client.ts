export interface RichMenuArea {
  x: number
  y: number
  width: number
  height: number
  type: string
  uri: string | null
  text: string | null
}

export interface BuddyRichMenu {
  label: string
  richMenuId: string
  selected: boolean
  width: number
  height: number
  imageUrl: string
  areas: RichMenuArea[]
}

export function createBuddyClient(runtime: any) {
  return {
    async getBuddyRichMenu(buddyMid: string): Promise<BuddyRichMenu | null> {
      const detail = await runtime.sendBinary(
        '/BUDDY3',
        'getBuddyDetailWithPersonal',
        [
          [11, 1, buddyMid],
          [14, 2, [8, [0, 1, 2]]],
        ],
      )
      const buddy = detail.fields?.[0]?.[1]
      const personal = detail.fields?.[0]?.[2]
      const richMenuId = personal?.[1]
      if (!richMenuId) return null
      const chatBar = await runtime.sendBinary('/BUDDY3', 'getBuddyChatBarV2', [
        [
          12,
          1,
          [
            [11, 1, buddyMid],
            [10, 2, buddy?.[21] || 0],
            [11, 3, richMenuId],
          ],
        ],
      ])
      const rich = (chatBar.fields?.[0]?.[1] || [])
        .map((item: any) => item?.[1])
        .find((item: any) => typeof item?.[2] === 'string')
      if (!rich) return null
      let body: any
      try {
        body = JSON.parse(rich[2])
      } catch {
        return null
      }
      const canvas = body?.canvas
      const scene = body?.scenes?.[canvas?.initialScene]
      const image = Object.values(body?.images || {})[0] as any
      if (!canvas || !scene || !image?.imageUrl) return null
      const areas: RichMenuArea[] = (scene.listeners || []).flatMap(
        (listener: any) => {
          const [x, y, width, height] = listener?.params || []
          const action = body?.actions?.[listener?.action]
          if (![x, y, width, height].every(Number.isFinite) || !action)
            return []
          return [
            {
              x,
              y,
              width,
              height,
              type: String(action.type || ''),
              uri:
                typeof action.params?.linkUri === 'string'
                  ? action.params.linkUri
                  : null,
              text:
                typeof action.params?.text === 'string'
                  ? action.params.text
                  : null,
            },
          ]
        },
      )
      return {
        label: String(rich[1] || '選單'),
        richMenuId: String(richMenuId),
        selected: Boolean(rich[3]),
        width: Number(canvas.width),
        height: Number(canvas.height),
        imageUrl: String(image.imageUrl),
        areas,
      }
    },
  }
}
