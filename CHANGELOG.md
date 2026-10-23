# Changelog

本專案依循[語意化版本](https://semver.org/lang/zh-TW/)。

## [Unreleased]

### 新增

- `pktspec gen wireshark`：產生單一檔案的 Wireshark Lua dissector（3.6 以上），顯示封包、欄位與列舉名稱，截斷、未知 opcode、未知列舉值、長度超出等情況標專家資訊；`--port` 指定 TCP、UDP、伺服器連接埠的預設值，也可用 Decode As。
- `pktspec diff old.yaml new.yaml`：比對兩份定義，依 breaking、compatible、info 分組列出差異，附新舊檔行號與經過的封包；`--format json` 輸出給程式讀；有 breaking 時結束碼為 1。
- `pktspec gen csharp`：C# 9、.NET Standard 2.1 的類別，Unity 與 .NET 伺服器都能用，只依賴 `System` 底下的型別；`--namespace` 指定命名空間。
- `pktspec gen cpp`：C++17 純標頭檔，只依賴標準函式庫，伺服器與 Unreal、Unity 原生外掛都能用；`--namespace` 指定命名空間（`Example::Chat` 或 `Example.Chat`）。解碼回傳 `std::unique_ptr<Packet>`，錯誤都是 `std::runtime_error` 的子類別，結構全放 `Structs.hpp`。
- `pktspec gen typescript`：不依賴任何套件的 TypeScript 類別，瀏覽器與 Node.js 18 以上都能用；`u64`、`i64` 用 `bigint`，列舉用 `const` 物件加聯集型別，import 帶 `.js` 副檔名。

## [0.2.0] - 2026-10-21

第一個發布到 npm 的版本，可以用 `npx pktspec` 執行。

### 不相容的變更

- 封包、結構、列舉名稱必須以大寫字母開頭（#9）。

### 修正

- Java：`doc` 裡的反斜線與非 ASCII 文字會讓產生的類別無法編譯，現在一律輸出成純 ASCII（#7）。
- `check` 拒絕 `_1st`、`_` 這類去掉底線後不是字母開頭的欄位名稱，原本會產生無效的 Java 識別字；列舉值 `_` 在 Java 改成 `__`（#8）。
- `check` 要求封包、結構、列舉名稱以大寫字母開頭，並拒絕和內建型別同名；Java 產生器也拒絕和 `IllegalArgumentException` 等程式用到的類別同名（#9）。
- Java：列舉值取名 `value` 時和存放線上數值的欄位衝突，現在該欄位會自動改名（#10）。
- `check` 拒絕只差大小寫的封包、結構、列舉名稱，原本在不分大小寫的檔案系統上產生的檔案會互相覆蓋（#11）。
- 沒加引號的 `version: 1.10` 變成 `"1.1"`，現在照檔案裡的寫法保留（#12）。

## [0.1.0] - 2026-10-20

第一版。

### 新增

- YAML 定義檔：協定名稱、版本、位元組順序、opcode 型別（u8／u16），以及列舉、結構、封包。
- 型別：`u8`～`u64`、`i8`～`i64`、`f32`、`f64`、`bool`、`string`、`bytes`、固定長度 `bytes`、長度前綴陣列、固定長度陣列、巢狀結構、列舉。
- `pktspec check`：檢查 opcode 重複、名稱重複、未定義型別、無效的長度設定等，錯誤標出行號與欄位。
- `pktspec gen java`：只依賴 `java.nio.ByteBuffer` 的 Java 類別，Java 8 以上可編譯。
- `pktspec gen docs`：Markdown 欄位文件。

[Unreleased]: https://github.com/vtxe02023274/pktspec/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/vtxe02023274/pktspec/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vtxe02023274/pktspec/releases/tag/v0.1.0
