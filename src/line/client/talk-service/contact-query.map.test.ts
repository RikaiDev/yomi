import { describe, expect, test } from 'bun:test'
import { mapContactMap } from './contact-query.js'

describe('mapContactMap', () => {
  test('normalizes values of a map<string, Contact>', () => {
    const result = mapContactMap({
      abc_123: { 1: 'u1', 22: 'Alex', 27: 'School - Alex' },
    })
    expect(result).toEqual([
      {
        mid: 'u1',
        createdTime: null,
        type: null,
        status: null,
        relation: null,
        favoriteTime: null,
        capableVoiceCall: false,
        capableVideoCall: false,
        displayName: 'Alex',
        phoneticName: null,
        pictureStatus: null,
        thumbnailUrl: null,
        statusMessage: null,
        displayNameOverridden: 'School - Alex',
        picturePath: null,
        statusMessageContentMetadata: {},
        profileId: null,
        attributes: null,
        settings: null,
        notificationDisabled: false,
        isOfficial: false,
      },
    ])
  })

  test('returns an empty array for null', () => {
    expect(mapContactMap(null)).toEqual([])
  })
})
