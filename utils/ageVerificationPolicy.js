const DEFAULT_JURISDICTION = {
  code: 'GLOBAL',
  label: 'Other / Not Listed',
  countryCode: 'GLOBAL',
  countryName: 'Other / Not Listed',
  status: 'none',
  active: false,
  minimumAge: 18,
  requiresProofVerification: false,
  selfAttestationAllowed: true,
  summary: 'There is no active rule here that forces full age checks from us, so we can allow a lighter path unless that changes.'
}

export const AGE_VERIFICATION_JURISDICTIONS = [
  DEFAULT_JURISDICTION,
  {
    code: 'AU',
    label: 'Australia',
    countryCode: 'AU',
    countryName: 'Australia',
    status: 'required',
    active: true,
    minimumAge: 16,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Australia is actively fining platforms that do not block underage access, so we have to require stronger age checks there.'
  },
  {
    code: 'BR',
    label: 'Brazil',
    countryCode: 'BR',
    countryName: 'Brazil',
    status: 'upcoming',
    active: false,
    minimumAge: 16,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Brazil passed rules that are expected to kick in soon, so we track it now but are not forcing the full flow until it is active.'
  },
  {
    code: 'DK',
    label: 'Denmark',
    countryCode: 'DK',
    countryName: 'Denmark',
    status: 'planned',
    active: false,
    minimumAge: 15,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Denmark is pushing toward stricter youth access rules, but it is not settled enough yet for us to force the heavy flow.'
  },
  {
    code: 'EU',
    label: 'European Union',
    countryCode: 'EU',
    countryName: 'European Union',
    status: 'proposed',
    active: false,
    minimumAge: 16,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'The EU is clearly moving toward stricter age checks, but this item is not binding by itself so we are not treating it as a hard requirement yet.'
  },
  {
    code: 'FR',
    label: 'France',
    countryCode: 'FR',
    countryName: 'France',
    status: 'planned',
    active: false,
    minimumAge: 15,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'France has approved stricter under-15 rules, but until they are clearly live we are not treating them as fully enforceable on our side.'
  },
  {
    code: 'GB',
    label: 'United Kingdom',
    countryCode: 'GB',
    countryName: 'United Kingdom',
    status: 'conditional',
    active: true,
    minimumAge: 18,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'UK rules already expect age assurance around restricted content, so we need stronger checks there to avoid legal trouble.'
  },
  {
    code: 'KE',
    label: 'Kenya',
    countryCode: 'KE',
    countryName: 'Kenya',
    status: 'unclear',
    active: false,
    minimumAge: 18,
    requiresProofVerification: false,
    selfAttestationAllowed: true,
    summary: 'Kenya is discussing this space, but the rule position is still unclear enough that we are not forcing the full flow yet.'
  },
  {
    code: 'MY',
    label: 'Malaysia',
    countryCode: 'MY',
    countryName: 'Malaysia',
    status: 'required',
    active: true,
    minimumAge: 16,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Malaysia expects real age checks for under-16 restrictions, so we cannot risk handling that jurisdiction loosely.'
  },
  {
    code: 'NO',
    label: 'Norway',
    countryCode: 'NO',
    countryName: 'Norway',
    status: 'planned',
    active: false,
    minimumAge: 15,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Norway is moving toward stricter youth access rules, but it is not in a place where we should hard-force the full check yet.'
  },
  {
    code: 'NZ',
    label: 'New Zealand',
    countryCode: 'NZ',
    countryName: 'New Zealand',
    status: 'proposed',
    active: false,
    minimumAge: 16,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'New Zealand is considering tougher age restrictions, but it is not active enough yet for us to force full verification.'
  },
  {
    code: 'PG',
    label: 'Papua New Guinea',
    countryCode: 'PG',
    countryName: 'Papua New Guinea',
    status: 'required',
    active: true,
    minimumAge: 14,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Papua New Guinea expects age verification through local ID-based checks, so we have to treat it as a strict jurisdiction.'
  },
  {
    code: 'ES',
    label: 'Spain',
    countryCode: 'ES',
    countryName: 'Spain',
    status: 'proposed',
    active: false,
    minimumAge: 16,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Spain has announced tougher age rules, but until those rules are actually in force we are not forcing the strict path.'
  },
  {
    code: 'US',
    label: 'United States (General)',
    countryCode: 'US',
    countryName: 'United States',
    status: 'mixed',
    active: false,
    minimumAge: 18,
    requiresProofVerification: false,
    selfAttestationAllowed: true,
    summary: 'The US is messy on this. Federal pressure exists, but the real enforcement risk depends on the state.'
  },
  {
    code: 'US-FL',
    label: 'United States - Florida',
    countryCode: 'US',
    countryName: 'United States',
    status: 'required',
    active: true,
    minimumAge: 18,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Florida has active enforcement risk around youth access, so we need the stronger check there.'
  },
  {
    code: 'US-MS',
    label: 'United States - Mississippi',
    countryCode: 'US',
    countryName: 'United States',
    status: 'required',
    active: true,
    minimumAge: 18,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Mississippi has active age-verification enforcement risk, so we cannot treat it as optional.'
  },
  {
    code: 'US-SC',
    label: 'United States - South Carolina',
    countryCode: 'US',
    countryName: 'United States',
    status: 'conditional',
    active: true,
    minimumAge: 18,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'South Carolina expects services to show how they handle age checks, so we treat it as a stricter compliance state.'
  },
  {
    code: 'US-TN',
    label: 'United States - Tennessee',
    countryCode: 'US',
    countryName: 'United States',
    status: 'required',
    active: true,
    minimumAge: 18,
    requiresProofVerification: true,
    selfAttestationAllowed: false,
    summary: 'Tennessee has active rules around age checks and youth access, so we need the stricter flow there.'
  }
]

const jurisdictionMap = new Map(AGE_VERIFICATION_JURISDICTIONS.map((item) => [item.code, item]))

const toBoolean = (value) => value === true || value === 1 || value === '1' || value === 'true'

const toFiniteNumber = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export const getAgeVerificationJurisdiction = (code) => {
  if (!code || !jurisdictionMap.has(code)) return DEFAULT_JURISDICTION
  return jurisdictionMap.get(code)
}

export const getAgeVerificationJurisdictionCode = (user = {}, verification = null) => {
  return user?.ageVerificationJurisdiction || verification?.jurisdictionCode || DEFAULT_JURISDICTION.code
}

export const normalizeAgeVerification = (verification, user = {}) => {
  const hasRecord = verification && typeof verification === 'object' && Object.keys(verification).length > 0
  const jurisdiction = getAgeVerificationJurisdiction(getAgeVerificationJurisdictionCode(user, verification))
  const category = verification?.category === 'child' ? 'child' : (hasRecord ? 'adult' : null)
  const verified = hasRecord ? toBoolean(verification?.verified) : false
  const expiresAt = verification?.expiresAt || null
  const isExpired = !!expiresAt && new Date(expiresAt) < new Date()
  const age = toFiniteNumber(verification?.age)
  const estimatedAge = toFiniteNumber(verification?.estimatedAge ?? verification?.age)
  const selfDeclaredAdult = hasRecord ? toBoolean(verification?.selfDeclaredAdult) : false
  const proofVerifiedAdult = verified && category === 'adult' && !isExpired
  const adultAccess = proofVerifiedAdult || (selfDeclaredAdult && jurisdiction.selfAttestationAllowed && !isExpired)

  let riskLevel = 'unverified'
  let riskLabel = 'Unverified'
  if (proofVerifiedAdult) {
    riskLevel = 'none'
    riskLabel = 'Verified'
  } else if (selfDeclaredAdult && adultAccess) {
    riskLevel = 'self_attested_adult'
    riskLabel = 'Self-attested adult'
  } else if (verified && category === 'child') {
    riskLevel = 'minor'
    riskLabel = 'Minor'
  }

  return {
    hasRecord,
    verified,
    proofVerifiedAdult,
    adultAccess,
    selfDeclaredAdult,
    category,
    method: verification?.method || null,
    birthYear: verification?.birthYear || null,
    age,
    estimatedAge,
    proofSummary: verification?.proofSummary || {},
    verifiedAt: verification?.verifiedAt || null,
    selfAttestedAt: verification?.selfAttestedAt || null,
    expiresAt,
    isExpired,
    device: verification?.device || null,
    source: verification?.source || null,
    jurisdictionCode: jurisdiction.code,
    jurisdictionName: jurisdiction.label,
    countryCode: jurisdiction.countryCode,
    countryName: jurisdiction.countryName,
    policyStatus: jurisdiction.status,
    policyActive: jurisdiction.active,
    policySummary: jurisdiction.summary,
    minimumAge: jurisdiction.minimumAge,
    requiresProofVerification: jurisdiction.requiresProofVerification,
    selfAttestationAllowed: jurisdiction.selfAttestationAllowed,
    riskLevel,
    riskLabel
  }
}
