// PB-339: the refused credentials' sentence, in one place.
//
// The server's answer body and the page's inline line under the password field are the same words,
// from this module, so the two surfaces cannot drift. The page does NOT paint the server's string:
// it asks the answer what it is (`code`) and paints its own copy. A 429 ("Too many attempts...")
// therefore never borrows the credentials sentence, and a rewording here moves both at once.
//
// The node arm (web/test/nodes/pb339_signin_inline.mjs) pins db.mjs to this constant; the page leg
// (tests/e2e/pb339-signin-inline.mjs) grades the pixels at 1024/1280/1440 and the mutant that
// removes the line.

export const CREDENTIALS_REFUSED = "Those credentials did not match.";

// The answer's identity, not its prose: the page keys the inline line on this, so no field id and
// no raw server text ever reaches the form.
export const CREDENTIALS_REFUSED_CODE = "credentials";
