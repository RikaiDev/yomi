import { expect, test } from 'bun:test'
import { buildUpdateContactNotificationRequest } from './requests.js'

test('builds LINE updateContactSetting notification-disable fields', () => {
  expect(buildUpdateContactNotificationRequest('u-contact', true)).toEqual([
    [8, 1, 0],
    [11, 2, 'u-contact'],
    [8, 3, 1],
    [11, 4, 'true'],
  ])
  expect(buildUpdateContactNotificationRequest('u-contact', false)[3]).toEqual([
    11,
    4,
    'false',
  ])
})
