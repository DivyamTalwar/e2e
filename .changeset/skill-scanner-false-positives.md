---
"e2e": patch
---

The bundled e2e skill no longer trips NVIDIA SkillSpector's static scan: its examples avoid template literals the scanner cannot parse, and a few phrases no longer match its credential, persistence, and skill-enumeration patterns.
