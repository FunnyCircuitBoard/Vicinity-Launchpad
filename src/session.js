/**
 * The two facts about a signed-in session that more than one file needs: the cookie's name and how long a full session lasts.
 * They live here, and not in src/auth.js, so that the sign-up's finish (src/signup-finish.js, which auth.js calls from the
 * Google callback) never has to import auth.js (no import cycle). auth.js re-exports them, so everything else is unchanged.
 */
export const SESSION_COOKIE = "vs";
export const SESSION_SECONDS = 30 * 86400;  // signed in for 30 days
