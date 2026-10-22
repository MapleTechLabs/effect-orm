---
"@maple-dev/effect-orm": patch
---

ClickHouse number literals read back as exactly the value you passed. A subnormal float (`5e-324`) was a syntax error and is now written from its bits; a whole number past 2^53 (`44812297868494010`) was written as its shortest decimal, which ClickHouse parses as a different integer, so `WHERE x = value` could miss the row — it is now written as the double's exact integer value.
