import { execFile } from "child_process";
import path from "path";

let backupInProgress = false;

let backupRunner = function defaultBackupRunner({ cwd = process.cwd() } = {}) {
  const child = execFile(
    process.execPath,
    [path.join(cwd, "backup.js")],
    {
      cwd,
      env: process.env,
      stdio: "ignore",
      detached: true
    }
  );
  child.unref();
  return child;
};

export function runBackupNow(options) {
  if (backupInProgress) {
    const err = new Error("Ya hay un backup en curso");
    err.code = "BACKUP_IN_PROGRESS";
    throw err;
  }

  backupInProgress = true;
  try {
    const result = backupRunner(options);
    if (result?.once) {
      const release = () => {
        backupInProgress = false;
      };
      result.once("exit", release);
      result.once("error", release);
      result.once("close", release);
    } else {
      backupInProgress = false;
    }
    return result;
  } catch (err) {
    backupInProgress = false;
    throw err;
  }
}

export function setBackupRunnerForTests(runner) {
  backupRunner = runner;
  backupInProgress = false;
}

export function resetBackupRunnerForTests() {
  backupInProgress = false;
  backupRunner = function defaultBackupRunner({ cwd = process.cwd() } = {}) {
    const child = execFile(
      process.execPath,
      [path.join(cwd, "backup.js")],
      {
        cwd,
        env: process.env,
        stdio: "ignore",
        detached: true
      }
    );
    child.unref();
    return child;
  };
}
