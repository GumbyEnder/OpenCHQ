// pb339_signin_inline — a refused sign-in names itself INSIDE the Sign in form, under the password
// field, in the page's own copy of the sentence, and that line is cleared by the next submit, by an
// edit, and by a successful sign-in.
//
// What breaks if this is removed (PM 10508 §2): the only surface that spoke was the bottom toast
// ("Those credentials did not match."), while the player's eyes and the two fields they had just
// typed into sat at the top of the card. Nothing about the words changes; the failure moves to where
// it is being looked at.
//
// Arms:
//   (a) ONE producer: public/signincopy.mjs carries the sentence and the answer's identity, and
//       db.mjs returns that constant from both login branches instead of typing the sentence;
//   (b) the live answer: POST /api/login with an unknown name and with a wrong password both answer
//       400 { error: <the constant>, code: "credentials" }, and a body without a code keeps its old
//       shape (main.mjs forwards the code only when the result carries one);
//   (c) the markup: #loginProblem is the LAST child of #login's fields (under the password input),
//       empty and hidden on first paint, with no sentence and no field id typed into the page;
//   (d) the page keys the line on the answer's CODE, paints the shared constant with textContent,
//       and never echoes err.message into the form;
//   (e) clearing: an input listener on each field and a clear at the top of the submit handler, so
//       the line lives only until the next submit or edit.
//
// The page leg that grades the pixels, the widths and the mutants is tests/e2e/pb339-signin-inline.mjs.

import { readFileSync } from "node:fs";
import { CREDENTIALS_REFUSED, CREDENTIALS_REFUSED_CODE } from "../../public/signincopy.mjs";

export const name = "pb339_signin_inline";

function fail(message) {
  throw new Error("node test pb339_signin_inline: " + message);
}

function eq(label, actual, expected) {
  if (actual !== expected) fail(label + ": got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}

function read(rel) {
  return readFileSync(new URL("../../public/" + rel, import.meta.url), "utf8");
}

export async function run(ctx) {
  // (a) the producer.
  eq("(a) the sentence is the answer body's own wording", CREDENTIALS_REFUSED, "Those credentials did not match.");
  eq("(a) the answer's identity is a stable key, not prose", CREDENTIALS_REFUSED_CODE, "credentials");

  const db = readFileSync(new URL("../../server/db.mjs", import.meta.url), "utf8");
  if (db.includes('"Those credentials did not match."')) fail("(a) db.mjs still types the sentence instead of importing it");
  if (!/import \{[^}]*CREDENTIALS_REFUSED[^}]*\} from "\.\.\/public\/signincopy\.mjs";/.test(db)) {
    fail("(a) db.mjs must import the sentence from public/signincopy.mjs");
  }
  const produced = (db.match(/\{ error: CREDENTIALS_REFUSED, code: CREDENTIALS_REFUSED_CODE \}/g) || []).length;
  if (produced !== 2) fail("(a) both login branches (unknown name, wrong password) must return one producer's sentence + code; found " + produced);

  // (b) the live answer, from the running suite server.
  const reply = async (body) => {
    const res = await fetch(ctx.base + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const unknown = await reply({ username: "pb339_no_such_handle", password: "whatever-pw" });
  eq("(b) an unknown name is refused", unknown.status, 400);
  eq("(b) an unknown name answers the shared sentence", unknown.data.error, CREDENTIALS_REFUSED);
  eq("(b) an unknown name answers the shared code", unknown.data.code, CREDENTIALS_REFUSED_CODE);

  const account = await ctx.register("Pb339Inline");
  const wrong = await reply({ username: account.user.username, password: "not-the-password" });
  eq("(b) a wrong password is refused", wrong.status, 400);
  eq("(b) a wrong password answers the shared sentence", wrong.data.error, CREDENTIALS_REFUSED);
  eq("(b) a wrong password answers the shared code", wrong.data.code, CREDENTIALS_REFUSED_CODE);

  const good = await reply({ username: account.user.username, password: "node-test-pass" });
  eq("(b) the right password signs in", good.status, 200);
  if (good.data.code) fail("(b) a successful answer must not carry a refusal code");

  const main = readFileSync(new URL("../../server/main.mjs", import.meta.url), "utf8");
  if (!/result\.code \? \{ error: result\.error, code: result\.code \} : \{ error: result\.error \}/.test(main)) {
    fail("(b) main.mjs must forward a result's code when it has one, and keep the old body shape when it does not");
  }

  // (c) the markup: inside the form, under the password field, empty until a refusal.
  const html = read("index.html");
  const login = html.slice(html.indexOf('<form id="login">'), html.indexOf("</form>", html.indexOf('<form id="login">')));
  if (!login) fail("(c) the Sign in form is gone from index.html");
  const problemAt = login.indexOf('id="loginProblem"');
  if (problemAt < 0) fail("(c) #loginProblem must live inside the Sign in form");
  const passwordAt = login.indexOf('name="password"');
  const buttonAt = login.indexOf("<button");
  if (!(passwordAt >= 0 && problemAt > passwordAt)) fail("(c) #loginProblem must sit under the password field");
  if (!(buttonAt < 0 || problemAt < buttonAt)) fail("(c) #loginProblem must sit under the password field, above the submit button");
  const tag = login.slice(login.lastIndexOf("<p", problemAt), login.indexOf(">", problemAt) + 1);
  if (!/\bhidden\b/.test(tag)) fail("(c) the line starts hidden: an empty warning is not painted on first load");
  if (!/class="formproblem"/.test(tag)) fail("(c) the line carries the formproblem class the stylesheet sizes");
  if (/Those credentials/.test(login)) fail("(c) the sentence must come from the producer, not from typed page copy");
  const inner = /id="loginProblem"[^>]*>([^<]*)</.exec(login);
  if (!inner) fail("(c) #loginProblem must be an empty element, not a self-closed placeholder");
  if (inner[1].trim() !== "") fail("(c) the line ships empty, got " + JSON.stringify(inner[1]));

  // (d) the page keys on the code and paints the constant.
  const app = read("app.js");
  if (!/import \{[^}]*CREDENTIALS_REFUSED[^}]*\} from "\.\/signincopy\.mjs";/.test(app)) {
    fail("(d) app.js must import the sentence from signincopy.mjs");
  }
  if (!/loginProblem\.textContent = CREDENTIALS_REFUSED;/.test(app)) fail("(d) the line must be painted with the shared constant");
  if (/loginProblem\.textContent = err\.message/.test(app)) fail("(d) the form must never echo the server's raw text");
  if (!/err\.code === CREDENTIALS_REFUSED_CODE/.test(app)) fail("(d) the inline line must be keyed on the answer's code, so a 429 keeps its own wording");
  if (!/err\.code = data\.code \|\| "";/.test(app)) fail("(d) post() must carry the answer's code to its caller");

  // (e) clearing: an edit clears it, and the next submit clears it before it can go stale.
  if (!/field\.addEventListener\("input", clearLoginProblem\)/.test(app)) fail("(e) editing a field must clear the line");
  if ((app.match(/clearLoginProblem\(\);/g) || []).length < 2) {
    fail("(e) the line is cleared at the top of the submit and again after a successful sign-in");
  }
}
