# Changelog

本專案依循[語意化版本](https://semver.org/lang/zh-TW/)。

## [0.1.0] - 2026-10-20

第一版。

### 新增

- YAML 定義檔：協定名稱、版本、位元組順序、opcode 型別（u8／u16），以及列舉、結構、封包。
- 型別：`u8`～`u64`、`i8`～`i64`、`f32`、`f64`、`bool`、`string`、`bytes`、固定長度 `bytes`、長度前綴陣列、固定長度陣列、巢狀結構、列舉。
- `pktspec check`：檢查 opcode 重複、名稱重複、未定義型別、無效的長度設定等，錯誤標出行號與欄位。
- `pktspec gen java`：只依賴 `java.nio.ByteBuffer` 的 Java 類別，Java 8 以上可編譯。
- `pktspec gen docs`：Markdown 欄位文件。

[0.1.0]: https://github.com/vtxe02023274/pktspec/releases/tag/v0.1.0
