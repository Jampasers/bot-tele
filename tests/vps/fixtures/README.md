# Offline registry test fixture

`minimal-software-hive.base64` encodes the 8 KiB root-only registry hive from
[libguestfs/hivex images/minimal](https://github.com/libguestfs/hivex/blob/master/images/minimal)
(Git blob `3f4ee58c0adc1c3a73da8fed459304fd1083fce7`).
Richard W. M. Jones created this hand-edited test image; its origin is described
in [the upstream images README](https://github.com/libguestfs/hivex/blob/master/images/README).
It has no Microsoft or Policies keys and contains no user credentials.

The startup regression copies it into a temporary directory, imports the exact
registry payload emitted by the installer patch using `hivexregedit`, and checks
both a fresh hive and a repeat import with existing values and sibling keys.
Linux CI installs `libwin-hivex-perl`; on other development environments the
native registry test is skipped when `hivexregedit` is unavailable.
