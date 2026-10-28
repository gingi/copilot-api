import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as installer from "../scripts/install-service"

const { installService } = installer

const success = {
  pid: 1,
  output: [],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
}
const failure = { ...success, status: 1, stderr: "fixture failure" }

let root: string
let checkout: string
let config: string
let unit: string
let systemctlSpy: ReturnType<typeof spyOn<typeof childProcess, "spawnSync">>
let managerResult: typeof success

beforeEach(() => {
  // Intercept the imported function: changing PATH alone does not isolate
  // node:child_process on older Bun versions.
  systemctlSpy = spyOn(childProcess, "spawnSync")
  root = mkdtempSync(join(tmpdir(), "copilot-service-"))
  checkout = join(root, 'checkout with "quotes" \\ %h $HOME')
  config = join(root, "config with spaces")
  unit = join(config, "systemd/user/copilot-api.service")
  managerResult = {
    ...success,
    stdout: `/etc/systemd/user ${join(config, "systemd/user")} /usr/lib/systemd/user\n`,
  }
  systemctlSpy.mockReturnValue(managerResult)
  mkdirSync(join(checkout, "dist"), { recursive: true })
  mkdirSync(join(checkout, "scripts/systemd"), { recursive: true })
  writeFileSync(join(checkout, "dist/main.js"), "")
  copyFileSync(
    join(import.meta.dir, "../scripts/systemd/copilot-api.service.in"),
    join(checkout, "scripts/systemd/copilot-api.service.in"),
  )
})

afterEach(() => {
  systemctlSpy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

function commandLog() {
  return systemctlSpy.mock.calls
    .map(([, args]) => (Array.isArray(args) ? args.join(" ") : ""))
    .join("\n")
}

test("Installs an encoded regular unit and enables without starting it", () => {
  const bunPath = join(root, "bun with spaces %h $HOME")
  installService(checkout, bunPath, config)
  const content = readFileSync(unit, "utf8")
  expect(content).toContain(
    `WorkingDirectory=${checkout.replaceAll("%", "%%")}/`,
  )
  expect(content).toContain('ExecStart=:"')
  expect(content).toContain('%%h $HOME" run dist/main.js start')
  expect(content).toContain("Environment=NODE_ENV=production")
  expect(content).toContain("Environment=NODE_USE_SYSTEM_CA=1")
  expect(content).toContain("Restart=on-failure\nRestartSec=10s")
  expect(content).toContain("StandardOutput=journal")
  expect(content).toContain("WantedBy=default.target")
  expect(content).toContain(
    "Documentation=https://github.com/caozhiyuan/copilot-api",
  )
  expect(statSync(unit).isFile()).toBe(true)
  expect(statSync(unit).mode & 0o777).toBe(0o644)
  expect(systemctlSpy.mock.calls.map(([command]) => command)).toEqual([
    "systemctl",
    "systemctl",
    "systemctl",
  ])
  expect(commandLog()).toBe(
    "--user show --property=UnitPath --value\n--user daemon-reload\n--user enable copilot-api.service",
  )
})

test("Identical reruns preserve the unit and repeat reload and enable", () => {
  installService(checkout, process.execPath, config)
  const first = statSync(unit)
  installService(checkout, process.execPath, config)
  expect(statSync(unit).mtimeMs).toBe(first.mtimeMs)
  expect(commandLog().match(/--user enable copilot-api.service/g)).toHaveLength(
    2,
  )
})

test("Refuses a different existing unit with manual backup guidance", () => {
  mkdirSync(join(config, "systemd/user"), { recursive: true })
  writeFileSync(unit, "my existing unit")
  expect(() => installService(checkout, process.execPath, config)).toThrow(
    "Back up",
  )
  expect(readFileSync(unit, "utf8")).toBe("my existing unit")
  expect(commandLog()).toBe("")
})

test("Refuses symlinks rather than following or replacing them", () => {
  mkdirSync(join(config, "systemd/user"), { recursive: true })
  const target = join(root, "target")
  writeFileSync(target, "existing")
  symlinkSync(target, unit)
  expect(() => installService(checkout, process.execPath, config)).toThrow(
    "Back up",
  )
  expect(readFileSync(target, "utf8")).toBe("existing")
})

test("Missing build fails before writing or contacting systemd", () => {
  rmSync(join(checkout, "dist/main.js"))
  expect(() => installService(checkout, process.execPath, config)).toThrow(
    "bun run build",
  )
  expect(existsSync(unit)).toBe(false)
  expect(commandLog()).toBe("")
})

test("Rejects a shell-only config override outside the manager search path before writing", () => {
  systemctlSpy.mockReturnValueOnce({
    ...success,
    stdout: `/etc/systemd/user ${config}-other/systemd/user /usr/lib/systemd/user\n`,
  })
  expect(() => installService(checkout, process.execPath, config)).toThrow(
    "does not search",
  )
  expect(existsSync(unit)).toBe(false)
  expect(commandLog()).not.toContain("daemon-reload")
})

test("Unavailable user systemd fails before writing", () => {
  systemctlSpy.mockReturnValueOnce(failure)
  expect(() => installService(checkout, process.execPath, config)).toThrow(
    "fixture failure",
  )
  expect(existsSync(unit)).toBe(false)
})

test("Missing systemctl fails before writing", () => {
  systemctlSpy.mockReturnValueOnce({
    ...success,
    status: null,
    error: new Error("ENOENT"),
  })
  expect(() => installService(checkout, process.execPath, config)).toThrow(
    "ENOENT",
  )
  expect(existsSync(unit)).toBe(false)
})

test.each(["daemon-reload", "enable"])(
  "Reports %s failure and permits retry",
  (command) => {
    systemctlSpy.mockReturnValueOnce(managerResult)
    if (command === "enable") {
      systemctlSpy.mockReturnValueOnce(success)
    }
    systemctlSpy.mockReturnValueOnce(failure)
    expect(() => installService(checkout, process.execPath, config)).toThrow(
      "fixture failure",
    )
    expect(existsSync(unit)).toBe(true)
    if (command === "daemon-reload") {
      expect(commandLog()).not.toContain("--user enable")
    }
    installService(checkout, process.execPath, config)
    expect(commandLog()).toEndWith("--user enable copilot-api.service")
  },
)

test.each(["\n", "\r", "\t", "\0", "\u007f", "\u0085"])(
  "Rejects control characters in paths (%j) before writing",
  (control) => {
    expect(() =>
      installService(checkout, `/bun${control}path`, config),
    ).toThrow("control characters")
    expect(() =>
      installService(`${checkout}${control}`, process.execPath, config),
    ).toThrow("control characters")
    expect(() =>
      installService(checkout, process.execPath, `${config}${control}`),
    ).toThrow("control characters")
    expect(existsSync(unit)).toBe(false)
    expect(commandLog()).toBe("")
  },
)

test.each(['"', "'", "\\"])(
  "Rejects systemd-unsupported Bun path character %j",
  (character) => {
    expect(() =>
      installService(checkout, `/bun${character}path`, config),
    ).toThrow("Bun executable path")
    expect(existsSync(unit)).toBe(false)
    expect(commandLog()).toBe("")
  },
)

test("Rejects relative configuration paths before writing", () => {
  expect(() => installService(checkout, process.execPath, "relative")).toThrow(
    "absolute",
  )
  expect(commandLog()).toBe("")
})

test("CLI help does not install or contact systemd", () => {
  expect(installer).toHaveProperty("main")
  const output = spyOn(console, "log").mockImplementation(() => {})
  try {
    installer.main(["--help"], checkout)
    expect(output.mock.calls[0]?.[0]).toContain(
      "Does not build, authenticate, start, or restart",
    )
    expect(existsSync(unit)).toBe(false)
    expect(commandLog()).toBe("")
  } finally {
    output.mockRestore()
  }
})

test("CLI rejects unknown arguments before installing", () => {
  expect(() => installer.main(["--unknown"], checkout)).toThrow(
    "Unknown arguments",
  )
  expect(existsSync(unit)).toBe(false)
  expect(commandLog()).toBe("")
})

test("CLI uses the current Bun executable and XDG config directory", () => {
  const originalConfig = process.env.XDG_CONFIG_HOME
  const output = spyOn(console, "log").mockImplementation(() => {})
  process.env.XDG_CONFIG_HOME = config
  try {
    installer.main([], checkout)
    expect(readFileSync(unit, "utf8")).toContain(
      `ExecStart=:"${process.execPath.replaceAll("%", "%%")}"`,
    )
    expect(output.mock.calls[0]?.[0]).toContain("not started or restarted")
    expect(commandLog()).toEndWith("--user enable copilot-api.service")
  } finally {
    if (originalConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalConfig
    }
    output.mockRestore()
  }
})

test.skipIf(!Bun.which("systemd-analyze"))(
  "Systemd accepts the rendered unit with literal special characters in paths",
  () => {
    const bunPath = join(root, "bun with spaces %h $HOME")
    symlinkSync(process.execPath, bunPath)
    installService(checkout, bunPath, config)
    const result = Bun.spawnSync(
      ["systemd-analyze", "--user", "verify", unit],
      {
        env: { ...process.env },
      },
    )
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  },
)
