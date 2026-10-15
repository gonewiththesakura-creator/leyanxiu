import { hashAdminPassword } from "../admin-auth.js";

const password = process.argv[2];
if (!password) {
  console.error("用法: npm run admin:hash-password -- <至少12位的新密码>");
  process.exitCode = 1;
} else {
  try {
    console.log(hashAdminPassword(password));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
