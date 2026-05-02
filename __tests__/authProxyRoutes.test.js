import { describe, expect, it } from 'vitest'
import { buildOAuthUserRecord, findExistingOAuthUser, resolveExistingOAuthUser } from '../routes/authProxyRoutes.js'
import { userService } from '../services/dataService.js'

describe('buildOAuthUserRecord', () => {
  it('preserves existing admin and birthdate fields when OAuth payload omits them', () => {
    const existingUser = {
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      adminRole: 'owner',
      isAdmin: true,
      isModerator: true,
      birthDate: '2002-10-15',
      proofSummary: { verified: true },
      ageVerification: { verified: true, category: 'adult' }
    }

    const merged = buildOAuthUserRecord(
      {
        id: 'u_1',
        username: 'alice',
        displayName: 'Alice OAuth',
        email: 'alice@example.com'
      },
      existingUser
    )

    expect(merged.displayName).toBe('Alice OAuth')
    expect(merged.adminRole).toBe('owner')
    expect(merged.isAdmin).toBe(true)
    expect(merged.isModerator).toBe(true)
    expect(merged.birthDate).toBe('2002-10-15')
    expect(merged.proofSummary).toEqual({ verified: true })
    expect(merged.ageVerification).toEqual({ verified: true, category: 'adult' })
  })

  it('accepts upstream role fields for brand new OAuth users', () => {
    const merged = buildOAuthUserRecord({
      id: 'u_2',
      username: 'bob',
      email: 'bob@example.com',
      role: 'moderator',
      isAdmin: false,
      isModerator: true,
      birthDate: '2001-05-20'
    })

    expect(merged.adminRole).toBe('moderator')
    expect(merged.isAdmin).toBe(false)
    expect(merged.isModerator).toBe(true)
    expect(merged.birthDate).toBe('2001-05-20')
  })

  it('switches authProvider to oauth when local user logs in via OAuth', () => {
    const existingLocalUser = {
      id: '66523111a777067b3d6e0447',
      username: 'bluethefox',
      displayName: 'bluethefox',
      email: 'bluethefox@volt.voltagechat.app',
      authProvider: 'local',
      adminRole: 'owner',
      isAdmin: 1,
      isModerator: 0,
      birthDate: '2002-10-15',
      createdAt: '2026-04-03T05:27:08.764Z'
    }

    const merged = buildOAuthUserRecord(
      {
        id: 'enclica_oauth_subject_xyz',
        username: 'bluethefox',
        displayName: 'BlueTheFox',
        email: 'bluethefox@volt.voltagechat.app'
      },
      existingLocalUser
    )

    // authProvider should be 'enclica' (from OAuth config) not 'local'
    expect(merged.authProvider).toBe('enclica')
    // Must preserve admin role
    expect(merged.adminRole).toBe('owner')
    expect(merged.isAdmin).toBe(1)
    // Must preserve birthDate
    expect(merged.birthDate).toBe('2002-10-15')
    // oauthSubject should be set to OAuth provider's subject
    expect(merged.oauthSubject).toBe('enclica_oauth_subject_xyz')
    // Username should prefer upstream when provided
    expect(merged.username).toBe('bluethefox')
    // Email should match
    expect(merged.email).toBe('bluethefox@volt.voltagechat.app')
  })
})

describe('findExistingOAuthUser', () => {
  it('matches an existing account by normalized email when upstream id changes', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      local_user_1: {
        id: 'local_user_1',
        username: 'alice',
        email: 'alice@example.com',
        createdAt: '2025-01-01T00:00:00.000Z'
      }
    })

    try {
      const existing = findExistingOAuthUser({
        id: 'oauth_provider_new_id',
        username: 'alice-renamed',
        email: 'Alice@Example.com',
        emailVerified: true
      })

      expect(existing?.id).toBe('local_user_1')
      expect(existing?.createdAt).toBe('2025-01-01T00:00:00.000Z')
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('matches an existing local account by email even WITHOUT emailVerified flag', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      local_user_1: {
        id: 'local_user_1',
        username: 'bluethefox',
        email: 'blue@example.com',
        authProvider: 'local',
        adminRole: 'owner',
        isAdmin: true,
        createdAt: '2025-01-01T00:00:00.000Z'
      }
    })

    try {
      const existing = findExistingOAuthUser({
        id: 'enclica_oauth_subject_xyz',
        username: 'bluethefox',
        email: 'blue@example.com'
        // No emailVerified - OAuth provider didn't send this flag
      })

      expect(existing?.id).toBe('local_user_1')
      expect(existing?.authProvider).toBe('local')
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('flags ambiguous matches instead of picking a duplicate target', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      local_user_1: {
        id: 'local_user_1',
        username: 'alice',
        email: 'alice@example.com',
        oauthSubject: 'oauth_provider_new_id'
      },
      local_user_2: {
        id: 'local_user_2',
        username: 'alice-oauth',
        email: 'alice+oauth@example.com'
      }
    })

    try {
      const resolution = resolveExistingOAuthUser({
        id: 'oauth_provider_new_id',
        username: 'alice',
        email: 'alice+oauth@example.com',
        emailVerified: true
      })

      expect(resolution.user).toBeNull()
      expect(resolution.conflict).toContain('multiple existing users')
      expect(() => findExistingOAuthUser({
        id: 'oauth_provider_new_id',
        username: 'alice',
        email: 'alice+oauth@example.com',
        emailVerified: true
      })).toThrow(/multiple existing users/i)
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('matches by username as fallback when no email match exists', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      u_localuser: {
        id: 'u_localuser',
        username: 'bluethefox',
        email: 'different@example.com',
        authProvider: 'local',
        adminRole: 'owner',
        isAdmin: true
      }
    })

    try {
      const resolution = resolveExistingOAuthUser({
        id: 'enclica_subject_abc',
        username: 'bluethefox',
        email: 'oauth@enclica.com'
      })

      expect(resolution.user?.id).toBe('u_localuser')
      expect(resolution.matches[0].reason).toBe('username')
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('prioritizes oauthSubject match over email match when same user matches both', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      u_local: {
        id: 'u_local',
        username: 'other',
        email: 'other@example.com',
        authProvider: 'local'
      },
      oauth_user: {
        id: 'oauth_user',
        username: 'alice',
        email: 'alice@enclica.com',
        authProvider: 'oauth',
        oauthSubject: 'enclica_subject_123'
      }
    })

    try {
      const resolution = resolveExistingOAuthUser({
        id: 'enclica_subject_123',
        username: 'alice',
        email: 'alice@enclica.com',
        emailVerified: true
      })

      expect(resolution.user?.id).toBe('oauth_user')
      expect(resolution.matches[0].reason).toBe('oauthSubject')
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('prioritizes verified email over unverified email match', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      verified_user: {
        id: 'verified_user',
        username: 'alice',
        email: 'alice@example.com',
        authProvider: 'oauth',
        emailVerified: true
      }
    })

    try {
      const resolution = resolveExistingOAuthUser({
        id: 'enclica_new',
        username: 'alice',
        email: 'alice@example.com',
        emailVerified: true
      })

      expect(resolution.user?.id).toBe('verified_user')
      expect(resolution.matches[0].reason).toBe('emailVerified')
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('returns null when no matching user exists', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      u_local: {
        id: 'u_local',
        username: 'someone',
        email: 'someone@example.com',
        authProvider: 'local'
      }
    })

    try {
      const resolution = resolveExistingOAuthUser({
        id: 'enclica_new_user',
        username: 'totallynewuser',
        email: 'newuser@enclica.com'
      })

      expect(resolution.user).toBeNull()
      expect(resolution.matches).toHaveLength(0)
      expect(resolution.conflict).toBeNull()
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })

  it('deduplicates when same user matches by both email and username', () => {
    const originalGetAllUsers = userService.getAllUsers
    userService.getAllUsers = () => ({
      u_local: {
        id: 'u_local',
        username: 'bluethefox',
        email: 'bluethefox@volt.voltagechat.app',
        authProvider: 'local',
        adminRole: 'owner',
        isAdmin: true
      }
    })

    try {
      const resolution = resolveExistingOAuthUser({
        id: 'enclica_subject_456',
        username: 'bluethefox',
        email: 'bluethefox@volt.voltagechat.app'
      })

      expect(resolution.user?.id).toBe('u_local')
      expect(resolution.matches).toHaveLength(1)
      expect(resolution.conflict).toBeNull()
    } finally {
      userService.getAllUsers = originalGetAllUsers
    }
  })
})
