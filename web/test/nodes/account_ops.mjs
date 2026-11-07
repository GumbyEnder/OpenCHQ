// Account operations: a login limit, sessions that expire, and a password that can be changed.
// Owner: account_ops node.

export const name = "account_ops";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

async function call(base, path, body, token) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: "openchq_session=" + token } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  const cookie = (res.headers.getSetCookie() || [])[0] || "";
  const fresh = /openchq_session=([^;]*)/.exec(cookie);
  return { status: res.status, data, token: fresh ? fresh[1] : "" };
}

export async function run(ctx) {
  const base = ctx.base;

  // ---- a password can be changed, and the old one stops working -----------------------------
  const account = await ctx.register("OpsProbe");
  const other = await call(base, "/api/login", { username: account.user.username, password: "node-test-pass" });
  must(other.status === 200 && other.token, "a second session must sign in: " + JSON.stringify(other.data));

  const wrong = await call(base, "/api/password", { current: "not-the-password", next: "another-pass" }, account.token);
  must(wrong.status === 400, "a wrong current password must be refused, got " + wrong.status);
  must(/not the current password/i.test(String(wrong.data.error || "")), "the refusal must say which password is wrong: " + wrong.data.error);

  const short = await call(base, "/api/password", { current: "node-test-pass", next: "short" }, account.token);
  must(short.status === 400, "a short new password must be refused");

  const changed = await call(base, "/api/password", { current: "node-test-pass", next: "a-better-password" }, account.token);
  must(changed.status === 200 && changed.data.ok === true, "the change must succeed: " + JSON.stringify(changed.data));
  must(Number(changed.data.ended) >= 1, "another session must be ended by the change: " + JSON.stringify(changed.data));

  const oldLogin = await call(base, "/api/login", { username: account.user.username, password: "node-test-pass" });
  must(oldLogin.status === 400, "the old password must not sign in any more");
  const newLogin = await call(base, "/api/login", { username: account.user.username, password: "a-better-password" });
  must(newLogin.status === 200 && newLogin.token, "the new password must sign in: " + JSON.stringify(newLogin.data));

  const ended = await call(base, "/api/logout", {}, other.token);
  must(ended.status === 200, "logout must still answer");

  // ---- a session past its date is not a session --------------------------------------------
  const doomed = newLogin.token;
  const db = ctx.sqlite();
  const before = db.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(doomed);
  must(before && before.expires_at, "a new session must carry an expiry date");
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run("2000-01-01T00:00:00.000Z", doomed);
  const me = await fetch(base + "/api/me", { headers: { cookie: "openchq_session=" + doomed } });
  const meBody = await me.json();
  must(!meBody.user, "an expired session must not be a user: " + JSON.stringify(meBody));
  const gone = db.prepare("SELECT token FROM sessions WHERE token = ?").get(doomed);
  must(!gone, "an expired session must be deleted, not just refused");

  // ---- a caller that keeps failing is told to wait -----------------------------------------
  const fresh = await ctx.register("OpsProbe2");
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await call(base, "/api/login", { username: fresh.user.username, password: "wrong-" + i });
  }
  must(last.status === 429, "the sixth wrong password in a row must be rate limited, got " + last.status + " " + JSON.stringify(last.data));
  must(/try again/i.test(String(last.data.error || "")), "the limit must say to try again: " + last.data.error);

  // The right password is refused too while the lock is on: that is what a lock means.
  const locked = await call(base, "/api/login", { username: fresh.user.username, password: "node-test-pass" });
  must(locked.status === 429, "a locked caller must stay locked until the wait is over");
}
