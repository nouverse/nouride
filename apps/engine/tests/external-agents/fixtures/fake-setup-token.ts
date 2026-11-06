/**
 * A CLI's shared sign-in, for the account tests: a link to open, a code to paste — `CODE123` signs in — and then the
 * long-lived token, printed in two parts split inside it: the second only after the next line typed, so the page has
 * seen the first on its own, as a terminal may deliver it. Anything else at first exits 3.
 */

// Stopped, it ends 0, as a sign-in that was never finished does. Set before anything is printed: a test may stop it as
// soon as it asks for the code, and a stop in between ended it 143.
process.on("SIGTERM", () => process.exit(0));
process.stdout.write("Open https://login.example.test/token?c=1 and paste the code:\n");
let signedIn = false;
for await (const line of console) {
  if (signedIn) {
    process.stdout.write("CCCCDDDDEEEEFFFF\nStore it safely.\n");
    process.exit(0);
  }
  if (line.trim() !== "CODE123") process.exit(3);
  signedIn = true;
  process.stdout.write("Your token: fk-tok-AAAABBBB");
}
