/**
 * Bash command validation — constant tables.
 *
 * Ported verbatim from claw-code's bash_validation.rs. Source line references
 * are included on each table so future syncs are mechanical.
 *
 * claw source: rust/crates/runtime/src/bash_validation.rs
 */

// ---------------------------------------------------------------------------
// readOnlyValidation
// ---------------------------------------------------------------------------

/**
 * Commands that perform write operations and should be blocked in read-only mode.
 *
 * claw source: bash_validation.rs:52
 */
export const WRITE_COMMANDS = [
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
  "ln", "install", "tee", "truncate", "shred", "mkfifo", "mknod", "dd",
] as const;

/**
 * Commands that modify system state and should be blocked in read-only mode.
 *
 * claw source: bash_validation.rs:58
 */
export const STATE_MODIFYING_COMMANDS = [
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "brew",
  "pip",
  "pip3",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "cargo",
  "gem",
  "go",
  "rustup",
  "docker",
  "systemctl",
  "service",
  "mount",
  "umount",
  "kill",
  "pkill",
  "killall",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "crontab",
  "at",
] as const;

/**
 * Shell redirection operators that indicate writes.
 *
 * claw source: bash_validation.rs:97
 */
export const WRITE_REDIRECTIONS = [">", ">>", ">&"] as const;

/**
 * Git subcommands that are read-only safe.
 *
 * claw source: bash_validation.rs:163
 */
export const GIT_READ_ONLY_SUBCOMMANDS = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "stash",
  "remote",
  "fetch",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "describe",
  "shortlog",
  "blame",
  "bisect",
  "reflog",
  "config",
] as const;

/**
 * Patterns that indicate potentially destructive commands.
 * Each entry is a [pattern, message] tuple.
 *
 * claw source: bash_validation.rs:206
 */
export const DESTRUCTIVE_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["rm -rf /", "Recursive forced deletion at root — this will destroy the system"],
  ["rm -rf ~", "Recursive forced deletion of home directory"],
  ["rm -rf *", "Recursive forced deletion of all files in current directory"],
  ["rm -rf .", "Recursive forced deletion of current directory"],
  ["mkfs", "Filesystem creation will destroy existing data on the device"],
  ["dd if=", "Direct disk write — can overwrite partitions or devices"],
  ["> /dev/sd", "Writing to raw disk device"],
  ["chmod -R 777", "Recursively setting world-writable permissions"],
  ["chmod -R 000", "Recursively removing all permissions"],
  [":(){ :|:& };:", "Fork bomb — will crash the system"],
] as const;

/**
 * Commands that are always destructive regardless of arguments.
 *
 * claw source: bash_validation.rs:235
 */
export const ALWAYS_DESTRUCTIVE_COMMANDS = ["shred", "wipefs"] as const;

/**
 * Commands that are read-only (no filesystem or state modification).
 *
 * claw source: bash_validation.rs:389
 */
export const SEMANTIC_READ_ONLY_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "which",
  "whereis",
  "whatis",
  "man",
  "info",
  "file",
  "stat",
  "du",
  "df",
  "free",
  "uptime",
  "uname",
  "hostname",
  "whoami",
  "id",
  "groups",
  "env",
  "printenv",
  "echo",
  "printf",
  "date",
  "cal",
  "bc",
  "expr",
  "test",
  "true",
  "false",
  "pwd",
  "tree",
  "diff",
  "cmp",
  "md5sum",
  "sha256sum",
  "sha1sum",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "seq",
  "yes",
  "tput",
  "column",
  "jq",
  "yq",
  "xargs",
  "tr",
  "cut",
  "paste",
  "awk",
  "sed",
] as const;

/**
 * Commands that perform network operations.
 *
 * claw source: bash_validation.rs:460
 */
export const NETWORK_COMMANDS = [
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "nc",
  "ncat",
  "telnet",
  "ping",
  "traceroute",
  "dig",
  "nslookup",
  "host",
  "whois",
  "ifconfig",
  "ip",
  "netstat",
  "ss",
  "nmap",
] as const;

/**
 * Commands that manage processes.
 *
 * claw source: bash_validation.rs:485
 */
export const PROCESS_COMMANDS = [
  "kill", "pkill", "killall", "ps", "top", "htop", "bg", "fg", "jobs",
  "nohup", "disown", "wait", "nice", "renice",
] as const;

/**
 * Commands that manage packages.
 *
 * claw source: bash_validation.rs:491
 */
export const PACKAGE_COMMANDS = [
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "pip", "pip3", "npm",
  "yarn", "pnpm", "bun", "cargo", "gem", "go", "rustup", "snap", "flatpak",
] as const;

/**
 * Commands that require system administrator privileges.
 *
 * Note: claw's bash_validation.rs names this SYSTEM_ADMIN_COMMANDS internally;
 * exported here as SYSTEM_ADMIN_COMMANDS for use by intent.ts.
 */
export const SYSTEM_ADMIN_COMMANDS = [
  "sudo",
  "su",
  "chroot",
  "mount",
  "umount",
  "fdisk",
  "parted",
  "lsblk",
  "blkid",
  "systemctl",
  "service",
  "journalctl",
  "dmesg",
  "modprobe",
  "insmod",
  "rmmod",
  "iptables",
  "ufw",
  "firewall-cmd",
  "sysctl",
  "crontab",
  "at",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "passwd",
  "visudo",
] as const;
