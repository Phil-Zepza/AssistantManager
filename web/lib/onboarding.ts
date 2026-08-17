// Cookie set when a user chooses "Do this later" on the onboarding screen, so
// the dashboard stops forcing them there and lets them into the app. Not auth —
// just a UI preference; it becomes irrelevant once they link a team.
export const ONBOARDING_SKIP_COOKIE = "am_onboarding_skipped";
