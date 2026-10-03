/**
 * Feature switches, read from the environment on every request (a dashboard variable change applies to
 * the next request, no deploy). Deliberately NOT in wrangler.jsonc "vars": a deploy would reset it.
 *
 * SIGNUP_FLOW=v2 turns on the new sign-up (location, account with terms, wallet, dashboard).
 * Anything else (unset, empty, "v1", a typo) is the sign-up as it has always been.
 */
export const signupFlow = (env) => (String((env && env.SIGNUP_FLOW) ?? "").trim().toLowerCase() === "v2" ? "v2" : "v1");
export const v2On = (env) => signupFlow(env) === "v2";
