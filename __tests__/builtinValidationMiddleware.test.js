import { describe, expect, it } from 'vitest'
import { validationSchemas } from '../middleware/builtinValidationMiddleware.js'

describe('validationSchemas.userProfile', () => {
  it('allows partial profile updates without username', () => {
    const errors = validationSchemas.userProfile.flatMap((rule) =>
      rule.validate({ birthDate: '2002-10-15' }[rule.field.replace('body.', '')])
    )

    expect(errors).toEqual([])
  })

  it('still validates username when provided', () => {
    const errors = validationSchemas.userProfile.flatMap((rule) =>
      rule.validate({ username: 'bad name' }[rule.field.replace('body.', '')])
    )

    expect(errors).toEqual([
      {
        field: 'body.username',
        message: 'Username must be 2-32 characters, alphanumeric with underscores and periods only',
        value: 'bad name'
      }
    ])
  })
})
