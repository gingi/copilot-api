import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const unitName = "copilot-api.service"

function quotePath(path: string): string {
  return `"${path.replaceAll("%", "%%")}"`
}

function systemctl(...args: string[]) {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}. Check that your systemd user manager is available.`,
    )
  }
  return result.stdout
}

export function installService(
  checkoutDir: string,
  bunPath: string,
  configHome: string,
): string {
  if (process.platform !== "linux") {
    throw new Error("This installer requires Linux with systemd user services.")
  }
  for (const path of [checkoutDir, bunPath, configHome]) {
    if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(path)) {
      throw new Error(
        "Service paths must not contain control characters or newlines.",
      )
    }
    if (!isAbsolute(path)) {
      throw new Error(`Service paths must be absolute: ${path}`)
    }
  }
  if (/["'\\]/.test(bunPath)) {
    throw new Error(
      "systemd does not support quotes or backslashes in the Bun executable path. Install Bun in a path without these characters.",
    )
  }
  if (
    !statSync(join(checkoutDir, "dist/main.js"), {
      throwIfNoEntry: false,
    })?.isFile()
  ) {
    throw new Error(
      "Missing dist/main.js. Run bun run build in the checkout first.",
    )
  }
  const template = readFileSync(
    join(checkoutDir, "scripts/systemd/copilot-api.service.in"),
    "utf8",
  )
  // Replace both markers in one pass so path text is never treated as a marker.
  // WorkingDirectory is a single literal path, not an ExecStart argument.
  // The trailing slash preserves a final space or backslash in the directory name.
  const content = template.replace(/@CHECKOUT@|@BUN@/g, (marker) =>
    marker === "@CHECKOUT@" ?
      `${checkoutDir.replaceAll("%", "%%")}/`
    : quotePath(bunPath),
  )
  const unitDir = join(configHome, "systemd/user")
  const unitPath = join(unitDir, unitName)
  const existing = lstatSync(unitPath, { throwIfNoEntry: false })
  if (
    existing
    && (!existing.isFile() || readFileSync(unitPath, "utf8") !== content)
  ) {
    throw new Error(
      `Refusing to overwrite ${unitPath}. Back up and move the existing unit out of the way manually, then rerun the installer.`,
    )
  }
  const unitPaths = systemctl("show", "--property=UnitPath", "--value").trim()
  if (!` ${unitPaths} `.includes(` ${unitDir} `)) {
    throw new Error(
      `The running systemd user manager does not search ${unitDir}. Use its configured XDG_CONFIG_HOME (or unset the shell override), then retry. Inspect paths with: systemctl --user show --property=UnitPath --value`,
    )
  }
  if (!existing) {
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(unitPath, content, { flag: "wx", mode: 0o644 })
    chmodSync(unitPath, 0o644)
  }
  // Always retry these steps, including after a previous partial installation.
  systemctl("daemon-reload")
  systemctl("enable", unitName)
  return unitPath
}

export function main(args: string[], checkoutDir: string): void {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun run scripts/install-service.ts\nInstalls and enables the systemd user service for this built checkout.\nDoes not build, authenticate, start, or restart the gateway.",
    )
    return
  }
  if (args.length > 0) {
    throw new Error("Unknown arguments. Use --help for usage.")
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const unitPath = installService(checkoutDir, process.execPath, configHome)
  console.log(
    `Installed ${unitPath}\nEnabled for future user sessions; not started or restarted.\nStart manually: systemctl --user start ${unitName}`,
  )
}

if (import.meta.main) {
  try {
    main(
      process.argv.slice(2),
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
