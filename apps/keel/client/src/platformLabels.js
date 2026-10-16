// Labels for the ISM platform totals catalogue (platform/v1). The API's
// `type` and `areas` values are identifiers, not labels: these are ours.
// English here; Portuguese in locales/pt/totals.js (keyed by the English).
import { t } from './i18n.js';

const TYPES = {
  players: 'Players', usersAll: 'All users', users: 'Staff users', usersPlayers: 'Player users', referees: 'Referees',
  informalContacts: 'Informal contacts', competitions: 'Competitions', clubs: 'Clubs', teams: 'Teams',
  personalDevelopment: 'Personal development', occurrences: 'Occurrences', behavioralEvaluation: 'Behavioural evaluations',
  workSessions: 'Work sessions', exitLogs: 'Exit logs', scoutingReports: 'Scouting reports',
  playersWithScoutingReport: 'Players with a scouting report', teamAnalysis: 'Team analyses', trainingSchemes: 'Training schemes',
  trainingUnities: 'Training units', technicalMeetings: 'Technical meetings', individualizedTrainings: 'Individual training sessions',
  gameFiles: 'Game files', gameReports: 'Game reports', tripPlans: 'Trip plans', gameCallFiles: 'Call-up files',
  internalReports: 'Internal reports', externalReports: 'External reports', playerGlobalEvaluations: 'Player overall evaluations',
  performanceReports: 'Performance reports', trainingContracts: 'Training contracts', workContracts: 'Employment contracts',
  agencies: 'Agencies', agents: 'Agents', playersReferred: 'Players referred', rehabilitationPlans: 'Rehabilitation plans',
  admissionExams: 'Admission exams', injuries: 'Injuries', treatmentSessions: 'Treatment sessions', maintenancePlans: 'Maintenance plans',
  nutritionalPlans: 'Nutrition plans', supplementationPlans: 'Supplementation plans', weighings: 'Weigh-ins',
  anthroprometries: 'Anthropometric measurements', cafeteriaMenus: 'Cafeteria menus', breakfast: 'Breakfasts', lunch: 'Lunches',
  snack: 'Snacks', dinner: 'Dinners', supper: 'Suppers', interviewFiles: 'Interview files', interviewReports: 'Interview reports',
  selfPerceptionQuestionnaires: 'Self-perception questionnaires', bedrooms: 'Bedrooms', internalFields: 'Internal pitches',
  accommodationEvaluations: 'Accommodation evaluations', stadiumFieldEvaluations: 'Stadium and pitch evaluations', suppliers: 'Suppliers',
  products: 'Products', movements: 'Stock movements', drivers: 'Drivers', vehicles: 'Vehicles', gameModifications: 'Game changes',
  webLogins: 'Web logins', appLogins: 'App logins', specializedTrainings: 'Specialised training sessions',
  uniqueWebUsers: 'Unique web users', uniqueAppUsers: 'Unique app users',
};

// In the order the Platform Totals screen lists its sections.
export const AREAS = ['administration', 'academic', 'scouting', 'training', 'performance', 'legalAndAgents', 'medical', 'nutrition', 'meals', 'psychologic', 'facility', 'equipments', 'administrative'];
const AREA_LABELS = {
  administration: 'Administration', academic: 'Academy', scouting: 'Scouting', training: 'Training', performance: 'Performance',
  legalAndAgents: 'Legal and agents', medical: 'Medical', nutrition: 'Nutrition', meals: 'Meals', psychologic: 'Psychology',
  facility: 'Facilities', equipments: 'Equipment', administrative: 'Administrative services',
};

/** The figures the overview shows by default: people and how much they use the platform. */
export const KEY_FIGURES = ['players', 'usersAll', 'uniqueWebUsers', 'uniqueAppUsers', 'webLogins', 'appLogins'];

// A type we don't know yet ("newThing") still reads as words ("New thing").
const humanize = (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export const figureLabel = (type) => (TYPES[type] ? t(TYPES[type]) : humanize(type));
export const areaLabel = (area) => (AREA_LABELS[area] ? t(AREA_LABELS[area]) : humanize(area));
