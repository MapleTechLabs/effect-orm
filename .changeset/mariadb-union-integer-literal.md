---
"@maple-dev/effect-orm": patch
---

MariaDB: an integer literal in a `unionAll` branch keeps its value beside a DECIMAL in another branch. MariaDB 11.4 sizes an integer literal one digit short when a union branch is a derived table, which is how `mariadbDialect` writes branches, and cut it down to fit: `lit(97)` in one branch and a `DECIMAL(5,4)` in the other came back `9.9999`. A selected integer literal is now written `CAST(n AS SIGNED) + 0` on MariaDB, which has the digits. MySQL is unaffected and unchanged.
