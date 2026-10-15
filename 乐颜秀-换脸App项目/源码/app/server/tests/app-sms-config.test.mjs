import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertPrivateFile, planSmsConfig, updateSmsConfigFiles } from '../deploy/update-app-sms-config.mjs';

const original = '# retain this comment\r\nDEPLOY_ENV=staging\r\nPAYMENT_MODE=closed_test\r\nCLOSED_TEST_MODE=true\r\nCLOSED_TEST_REQUIRE_INVITE=true\r\nAPP_LOGIN_ENABLED=true\r\nACCOUNT_OTP_SECRET=' + 'test-only-'.repeat(5)
  + '\r\nAUTH_SESSION_SECRET=other-test-only-secret\r\nBILLING_DATABASE_URL="postgres://test:keep@127.0.0.1/test"\r\n# budget\r\nSMS_DAILY_LIMIT=20\r\n';
const patch = {
  SMS_PROVIDER: 'aliyun', SMS_ACCESS_KEY_ID: 'fake-test-id', SMS_ACCESS_KEY_SECRET: 'fake-test-secret',
  SMS_SIGN_NAME: '测试企业', SMS_TEMPLATE_CODE: 'SMS_TEST123', SMS_DAILY_LIMIT: 10,
  PRIVACY_POLICY_URL: 'https://REDACTED_COMPANY_INFRASTRUCTURE/privacy', USER_AGREEMENT_URL: 'https://REDACTED_COMPANY_INFRASTRUCTURE/terms',
};

test('patch preserves OTP, other secrets, comments and protected lines byte-for-byte', () => {
  const plan = planSmsConfig(original, patch);
  for (const line of original.split(/(?<=\n)/).filter(line => !line.startsWith('SMS_DAILY_LIMIT='))) {
    assert.ok(plan.text.includes(line));
  }
  assert.ok(plan.text.includes('# budget\r\nSMS_DAILY_LIMIT="10"\r\n'));
  assert.deepEqual(plan.changedFields, Object.keys(patch).sort());
  assert.equal(planSmsConfig(plan.text, patch).changedFields.length, 0);
});

test('unknown or protected patch fields, unsafe values and ambiguous target are rejected', () => {
  for (const key of ['ACCOUNT_OTP_SECRET', 'PAYMENT_MODE', 'CLOSED_TEST_REQUIRE_INVITE', 'OTHER']) {
    assert.throws(() => planSmsConfig(original, { ...patch, [key]: 'tampered' }), /UNKNOWN_FIELD/);
  }
  assert.throws(() => planSmsConfig(original, { ...patch, SMS_SIGN_NAME: 'x\nPAYMENT_MODE=live' }), /INVALID_PATCH_VALUE/);
  assert.throws(() => planSmsConfig(original + 'PAYMENT_MODE=live\n', patch), /AMBIGUOUS_ENV/);
  assert.throws(() => planSmsConfig(original.replace('PAYMENT_MODE=closed_test', 'PAYMENT_MODE=live'), patch), /CLOSED_TEST_REQUIRED/);
  for (const environment of ['production', 'PRODUCTION', 'development', '']) {
    assert.throws(() => planSmsConfig(original.replace('DEPLOY_ENV=staging', `DEPLOY_ENV=${environment}`), patch), /CLOSED_TEST_REQUIRED/);
  }
  assert.throws(() => planSmsConfig(original.replace('DEPLOY_ENV=staging\r\n', 'NODE_ENV=production\r\n'), patch), /CLOSED_TEST_REQUIRED/);
  assert.throws(() => planSmsConfig(original.replace('test-only-'.repeat(5), 'short'), patch), /OTP_SECRET_REQUIRED/);
});

test('ambiguous systemd/dotenv inline comments and backslashes are rejected, full-line comments survive', () => {
  for (const current of [
    original.replace('CLOSED_TEST_REQUIRE_INVITE=true', 'CLOSED_TEST_REQUIRE_INVITE=true # ignored by dotenv only'),
    original.replace('SMS_DAILY_LIMIT=20', 'SMS_DAILY_LIMIT="20" # budget'),
    original + 'OTHER=first\\second\n',
    original + 'OTHER="first\\nsecond"\n',
    original + "OTHER='first\\second'\n",
  ]) assert.throws(() => planSmsConfig(current, patch), /AMBIGUOUS_ENV/);
  const comments = '# full line # comment with \\ backslash\r\n; another full line comment\r\n';
  assert.ok(planSmsConfig(comments + original, patch).text.startsWith(comments));
});

test('budget cannot exceed current limit or the 20-message closed-test ceiling', () => {
  for (const value of [21, 200, 0, -1, 1.5, '1e1']) {
    assert.throws(() => planSmsConfig(original, { ...patch, SMS_DAILY_LIMIT: value }));
  }
  assert.throws(() => planSmsConfig(original.replace('SMS_DAILY_LIMIT=20', 'SMS_DAILY_LIMIT=5'), patch), /BUDGET_INCREASE_REFUSED/);
  assert.throws(() => planSmsConfig(original.replace('SMS_DAILY_LIMIT=20', 'SMS_DAILY_LIMIT=200'), patch), /INVALID_EXISTING_BUDGET/);
});

test('policy links must be HTTPS without credentials or placeholder hosts', () => {
  for (const url of ['http://REDACTED_COMPANY_INFRASTRUCTURE/privacy', 'https://REDACTED_USER:REDACTED_PASSWORD@REDACTED_COMPANY_INFRASTRUCTURE/privacy', 'https://example.com/privacy', 'https://app.invalid/privacy', 'https://localhost/privacy', 'https://127.0.0.1/privacy', '']) {
    assert.throws(() => planSmsConfig(original, { ...patch, PRIVACY_POLICY_URL: url }));
  }
});

test('metadata rejects symlinks, hardlinks, non-0600 files, directories and wrong ownership', () => {
  const stat = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o100600, uid: 0 };
  assert.doesNotThrow(() => assertPrivateFile(stat, 0));
  for (const altered of [{ mode: 0o100644 }, { mode: 0o100400 }, { nlink: 2 }, { isFile: () => false }, { isSymbolicLink: () => true }, { uid: 1 }]) {
    assert.throws(() => assertPrivateFile({ ...stat, ...altered }, 0));
  }
});

async function fixture(run, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'app-sms-config-test-'));
  await fs.chmod(directory, 0o700);
  const targetPath = path.join(directory, 'server.env');
  const inputPath = path.join(directory, 'sms.json');
  await fs.writeFile(targetPath, original, { mode: 0o600 });
  await fs.writeFile(inputPath, JSON.stringify(patch), { mode: 0o600 });
  // Windows lacks Unix mode bits; emulate only those metadata bits for real temp-file
  // transaction tests. Security validation above tests all actual mode rejections.
  const metadata = stat => {
    if (process.platform === 'win32') stat.mode = (stat.mode & ~0o7777) | (stat.isDirectory() ? 0o700 : 0o600);
    return stat;
  };
  const io = {
    ...fs,
    lstat: async name => metadata(await fs.lstat(name)),
    open: async (...args) => {
      const handle = await fs.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => metadata(await stat());
      return handle;
    },
    ...overrides,
  };
  try { await run({ directory, targetPath, inputPath, io }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('dry-run makes no writes and returns only field names and apply status', async () => {
  await fixture(async ({ directory, targetPath, inputPath, io }) => {
    const result = await updateSmsConfigFiles({ targetPath, inputPath }, io);
    assert.deepEqual(result, { applied: false, changedFields: Object.keys(patch).sort() });
    assert.deepEqual((await fs.readdir(directory)).sort(), ['server.env', 'sms.json']);
    assert.equal(await fs.readFile(targetPath, 'utf8'), original);
  });
});

test('file entrypoint rejects unsafe input and target files before any writes', async () => {
  for (const target of ['targetPath', 'inputPath']) {
    for (const unsafe of ['symlink', 'permissions']) {
      await fixture(async fields => {
        const { directory, targetPath, inputPath, io } = fields;
        const normalLstat = io.lstat;
        io.lstat = async name => {
          const stat = await normalLstat(name);
          if (name === fields[target]) {
            if (unsafe === 'symlink') stat.isSymbolicLink = () => true;
            else stat.mode = 0o100644;
          }
          return stat;
        };
        await assert.rejects(updateSmsConfigFiles({ targetPath, inputPath, apply: true }, io), /UNSAFE_FILE_TYPE|FILE_MODE_MUST_BE_0600/);
        assert.equal(await fs.readFile(targetPath, 'utf8'), original);
        assert.deepEqual((await fs.readdir(directory)).sort(), ['server.env', 'sms.json']);
      });
    }
  }
});

test('ambiguous input configuration leaves the target byte-for-byte unchanged with no backup or temporary files', async () => {
  await fixture(async ({ directory, targetPath, inputPath, io }) => {
    const ambiguous = original.replace('CLOSED_TEST_REQUIRE_INVITE=true', 'CLOSED_TEST_REQUIRE_INVITE=true # ambiguous');
    await fs.writeFile(targetPath, ambiguous);
    await assert.rejects(updateSmsConfigFiles({ targetPath, inputPath, apply: true }, io), /AMBIGUOUS_ENV/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), ambiguous);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['server.env', 'sms.json']);
  });
});

test('apply preserves an exact protected backup and commits the whole replacement', async () => {
  await fixture(async ({ directory, targetPath, inputPath, io }) => {
    const result = await updateSmsConfigFiles({ targetPath, inputPath, apply: true }, io);
    assert.equal(result.applied, true);
    assert.equal(await fs.readFile(targetPath, 'utf8'), planSmsConfig(original, patch).text);
    const backups = (await fs.readdir(directory)).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(directory, backups[0]), 'utf8'), original);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(targetPath)).mode & 0o7777, 0o600);
      assert.equal((await fs.stat(path.join(directory, backups[0]))).mode & 0o7777, 0o600);
    }
    assert.equal((await fs.readdir(directory)).some(name => /\.tmp$|\.lock$/.test(name)), false);
  });
});

test('rename failure leaves original intact and cleans temporary replacement and lock', async () => {
  await fixture(async ({ directory, targetPath, inputPath, io }) => {
    await assert.rejects(updateSmsConfigFiles({ targetPath, inputPath, apply: true }, io), /INJECTED_RENAME_FAILURE/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), original);
    assert.equal((await fs.readdir(directory)).some(name => /\.tmp$|\.lock$/.test(name)), false);
    const backup = (await fs.readdir(directory)).find(name => name.endsWith('.bak'));
    assert.equal(await fs.readFile(path.join(directory, backup), 'utf8'), original);
  }, { rename: async () => { throw new Error('INJECTED_RENAME_FAILURE'); } });
});

test('a partial temporary-file write failure leaves the complete original in place', async () => {
  await fixture(async ({ directory, targetPath, inputPath, io }) => {
    const normalOpen = io.open;
    io.open = async (...args) => {
      const handle = await normalOpen(...args);
      if (args[0].endsWith('.tmp')) {
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async bytes => {
          await writeFile(bytes.subarray(0, 12));
          throw new Error('INJECTED_WRITE_FAILURE');
        };
      }
      return handle;
    };
    await assert.rejects(updateSmsConfigFiles({ targetPath, inputPath, apply: true }, io), /INJECTED_WRITE_FAILURE/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), original);
    assert.equal((await fs.readdir(directory)).some(name => /\.tmp$|\.lock$/.test(name)), false);
  });
});

test('concurrent target edits are detected before replacement', async () => {
  await fixture(async ({ targetPath, inputPath, io }) => {
    const normalLstat = io.lstat;
    let targetReads = 0;
    io.lstat = async name => {
      if (name === targetPath && ++targetReads === 2) await fs.appendFile(targetPath, '# concurrent edit\n');
      return normalLstat(name);
    };
    await assert.rejects(updateSmsConfigFiles({ targetPath, inputPath, apply: true }, io), /TARGET_CHANGED/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), original + '# concurrent edit\n');
  });
});
