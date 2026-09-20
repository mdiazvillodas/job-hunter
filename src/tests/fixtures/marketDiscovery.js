'use strict';

module.exports = function fixture() {
  return {
    profile: {
      meta: { person: 'Example Person', email: 'person@example.invalid' },
      capabilities: [
        { statement: 'Coordinate technical teams', evidence: ['Example Person coordinated three teams.'] },
        { statement: 'Unsupported claimed expertise', evidence: [] },
      ],
      targetResponsibilities: [
        { statement: 'Water quality monitoring', evidence: ['Managed water monitoring programmes'], language: 'en' },
        { statement: 'Environmental permit coordination', evidence: ['Coordinated permit submissions'], language: 'en' },
      ],
      industries: [{ statement: 'Water infrastructure', evidence: ['Delivered a water infrastructure project'] }],
      seniority: { assessedLevel: 'Senior', evidence: ['Led technical teams'] },
      preferences: ['Technical coordination'], unknowns: ['No evidence recorded for offshore work'],
    },
    matchingProfile: {
      meta: { person: 'Example Person' },
      targetRoles: { primary: [{ roleFamily: 'Built environment', roles: ['Retail Architect', 'Senior Retail Architect', 'Project Architect Retail', 'Senior Architect Retail'], evidence: ['Explicitly supplied target roles'] }] },
      capabilities: { arbitraryTaxonomyBucket: { capabilities: ['Do not seed this taxonomy'], evidence: ['Legacy categorization'] } },
      roleTypesToAvoid: ['Exclusively administrative positions'],
      careerPreferences: { explicit: ['Technical coordination'], avoidAsPrimaryDirection: ['Exclusively administrative positions'] },
      decisionPhilosophy: { canSell: 'Presentation evidence is incomplete' },
      learnedPreferences: ['Never silently promote this into an exclusion'],
    },
    careerContext: {},
    config: { identity: { name: 'Example Person', linkedinUrl: 'https://example.invalid/person', email: 'person@example.invalid' },
      search: { locations: ['Example region'], modalities: ['hybrid'], targetAnalyzedJobs: 20,
        queryGroups: [{ label: 'Current', family: 'user', enabled: true, queries: [{ query: 'Unrelated query', enabled: true }] }] },
      notifications: { secret: 'PRIVATE_NOTIFICATION_VALUE' }, telegram: { secret: 'PRIVATE_TELEGRAM_VALUE' } },
  };
};
