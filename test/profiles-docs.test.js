// The owner-facing words about member profiles (README.md, docs/DEPLOY.md, the page's sentences) say what the code does: the
// lists behind the follower counts are visible to every signed-in member, only admin-console roles are unblockable, switching the
// feature off is instant for the server but not for a page that is already open, and auth_limits is not the profile migration's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const readme = read("README.md"), deploy = read("docs/DEPLOY.md"), profiles = read("src/profiles.js"), page = read("public/profile.js");

test("what other members can see names the follower and following LISTS, not only the counts (GET /api/follows?u= is open to every signed-in member)", () => {
  for (const [name, text] of [["README.md", readme], ["docs/DEPLOY.md", deploy], ["src/profiles.js", profiles]]) {
    assert.match(text, /follower and following(?:\n \*)? counts and the lists behind them \((who follows a member and whom they follow, as usernames|usernames), 50 a page\)/, name);
    assert.doesNotMatch(text, /follower and following(?:\n \*)? counts, and the/, `${name}: the counts-only sentence is gone`);
  }
});

test("only admin-console roles are unblockable; a founder or a manager is a member like any other to a block", () => {
  assert.match(readme, /members with an admin-console role \(owner, admin or moderator in `\/admin`\) cannot be blocked; a city founder or a country manager can be, like any member/);
  assert.doesNotMatch(readme, /admins and moderators cannot be blocked/);
  assert.match(profiles, /A city founder or a country manager is a member like any other here: a block only stops follows\./);
  assert.match(page, /cannot_block: "Members with an admin role can't be blocked\."/);
});

test("switching PROFILES off: instant for the server, while a dashboard that is already open keeps its blocks until it is reloaded", () => {
  assert.match(deploy, /are refused at once \(every profile route answers "not enabled"\), and the dashboard is as it was on the next page load\. A dashboard that was already open keeps the profile blocks it had drawn until it is reloaded/);
  assert.doesNotMatch(deploy, /vanish at once and the dashboard is as it was\./);
});

test("the first profile request adds users.bio and three tables; auth_limits is on every deployment already", () => {
  assert.match(deploy, /`auth_limits`, is not new to it: every deployment has it since the first rate-limited public request or feed vote/);
  assert.doesNotMatch(deploy, /plus `auth_limits` if the new sign-up has not made it already/);
  assert.match(deploy, /adds the column `users\.bio` and three tables \(`follows`, `blocks`, `profile_reports`\)\./);
});
