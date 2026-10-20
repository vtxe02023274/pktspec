# Changelog

本專案依循[語意化版本](https://semver.org/lang/zh-TW/)。

## [Unreleased]

### 修正

- Java：`doc` 裡的反斜線與非 ASCII 文字會讓產生的類別無法編譯，現在一律輸出成純 ASCII（#7）。
- `check` 拒絕 `_1st`、`_` 這類去掉底線後不是字母開頭的欄位名稱，原本會產生無效的 Java 識別字；列舉值 `_` 在 Java 改成 `__`（#8）。
- `check` 要求封包、結構、列舉名稱以大寫字母開頭，並拒絕和內建型別同名；Java 產生器也拒絕和 `IllegalArgumentException` 等程式用到的類別同名（#9）。

## [0.1.0] - 2026-10-20

第一版。

### 新增

- YAML 定義檔：協定名稱、版本、位元組順序、opcode 型別（u8／u16），以及列舉、結構、封包。
- 型別：`u8`～`u64`、`i8`～`i64`、`f32`、`f64`、`bool`、`string`、`bytes`、固定長度 `bytes`、長度前綴陣列、固定長度陣列、巢狀結構、列舉。
- `pktspec check`：檢查 opcode 重複、名稱重複、未定義型別、無效的長度設定等，錯誤標出行號與欄位。
- `pktspec gen java`：只依賴 `java.nio.ByteBuffer` 的 Java 類別，Java 8 以上可編譯。
- `pktspec gen docs`：Markdown 欄位文件。

[Unreleased]: https://github.com/vtxe02023274/pktspec/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vtxe02023274/pktspec/releases/tag/v0.1.0
