// Loaded by `npm test` (node --import) before every test file; node --test runs
// each file in a child process with the same --import flags, so this applies to
// all of them. A test file run on its own needs the same flag — README 11(a)
// gives the command.
//
// Tests must never read the real .env. On the phone it holds the live R2
// credentials of the session-backup bucket and, once one is chosen, the SMS
// provider's key: client.test.ts reached the real bucket from a plain
// `npm test`, and several tests assume no SMS provider is configured. Pointing
// dotenv at a file that does not exist gives every run the environment of a
// fresh checkout; each test file sets the fake values it needs.
// The same variables exported in the shell are removed for the same reason.
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DOTENV_CONFIG_PATH = path.join(tmpdir(), 'sms-api-tests-read-no-dotenv');

for (const name of ['SMS_PROVIDER', 'SMS_API_URL', 'SMS_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
  delete process.env[name];
}
