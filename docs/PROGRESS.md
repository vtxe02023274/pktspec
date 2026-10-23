# 進度

## 0.1.0

- 定義檔：`name`、`version`、`endian`、`opcode`（u8／u16）、`enums`、`structs`、`packets`。
- `check`：YAML 語法、缺少或未知的鍵、名稱重複（封包、結構、列舉共用命名空間）、同方向 opcode 重複、未定義型別（含大小寫建議）、`length`／`size` 用錯、數值範圍、結構自我包含。錯誤都帶行號與欄位。
- Java 產生器：只用 `java.nio.ByteBuffer`，Java 8 可編譯；每個封包一個類別，`<Name>Protocol` 依方向與 opcode 分派；寫入時檢查範圍與長度。
- 文件產生器：Markdown，封包總表＋每個封包、結構、列舉的欄位表。
- 測試：Vitest 單元測試、golden file（`test/golden/`）、Java 往返測試（`javac -Werror` 編譯後逐一編碼再解碼，並比對已知位元組）。

## 未發布

- C# 產生器：`pktspec gen csharp`，`--namespace` 指定命名空間（預設由協定名稱轉 PascalCase）；C# 9、.NET Standard 2.1，只用 `System` 底下的型別（`BinaryPrimitives`、`HashCode`）。
- 每個封包一個類別，`<Name>Protocol` 依方向與 opcode 分派；另產生 `IPacket`、`PacketReader`、`PacketWriter`，位元組順序在產生時固定。檔案不分子目錄。
- 與 Java 的差異：欄位用 PascalCase 屬性；整數用原生無號型別，不做範圍檢查；列舉成員改 PascalCase 並保證不重名；讀取失敗拋 `EndOfStreamException`、`InvalidDataException`，寫入失敗拋 `ArgumentException`。
- 欄位名稱和產生的成員、類別名稱、其他型別名稱衝突時，在後面補底線。型別名稱和 System 型別或產生的型別衝突則直接報錯。
- 測試：golden file（`test/golden/csharp/`）、C# 往返測試（用 `dotnet build -warnaserror` 編進 netstandard2.1 函式庫與可執行檔，逐一編碼再解碼，比對已知位元組，另驗證截斷與錯誤輸入的例外）；沒有 `dotnet` 時略過，`PKTSPEC_REQUIRE_DOTNET` 設定時改為失敗。
- TypeScript 產生器：`pktspec gen typescript`，沒有額外選項；只用 `DataView`、`Uint8Array`、`TextEncoder`、`TextDecoder`，瀏覽器與 Node 18 以上都能跑，編譯目標要 ES2020（`bigint`）。
- 每個型別一個 `.ts` 檔，另產生 `Packet`、`PacketReader`、`PacketWriter`、`PacketErrors`、`<Name>Codec`、`<Name>Protocol` 與 `index.ts`；檔案不分子目錄，import 一律帶 `.js`。
- 與 Java、C# 的差異：`u64`、`i64` 用 `bigint`，其餘整數用 `number`，寫入時檢查範圍並拒絕小數；列舉是 `const` 物件加聯集型別（不用 `enum`，開 `erasableSyntaxOnly` 也能編）；欄位用 camelCase，保留字欄位只在建構子參數加底線；`<Name>Protocol` 是物件常數；沒有 `hashCode`，只有 `equals`（浮點數用 `Object.is`）與 `toString`。
- 錯誤：寫入失敗丟 `RangeError`，資料不足丟 `TruncatedPacketError`，opcode、列舉值未知或長度超過 2^31 - 1 丟 `InvalidPacketError`。字串長度自己算 UTF-8 位元組數，孤立代理字元寫成 U+FFFD；解碼不吃掉開頭的 BOM。
- 型別名稱和 `Packet`、`Index`、`Uint8Array`、`Error` 這類產生的程式會用到的名稱衝突（不分大小寫）直接報錯。
- 測試：golden file（`test/golden/typescript/`）、TypeScript 往返測試（用專案的 `tsc` 以嚴格選項編進暫存目錄，含 `noUncheckedIndexedAccess`、`noUnusedLocals`、`verbatimModuleSyntax`、`erasableSyntaxOnly`，再用 Node 執行，逐一編碼再解碼，比對已知位元組，另驗證範圍、截斷與錯誤輸入）；不需要額外工具，所以沒有略過條件。

- `pktspec diff old.yaml new.yaml`：比對兩份定義，依 breaking／compatible／info 分組，`--format json` 給程式讀；兩個檔案都先過 `check` 的檢查，錯誤一起列出。`compile` 多回傳 `locations`（宣告位置），`src/diff.ts` 用它標行號。
- diff 規則依線上格式（opcode 加依序欄位，無名稱）：欄位新增、移除、型別或長度前綴改變、列舉底層型別改變、值移除或改號一律 breaking；改名、doc、version 是 info；新封包、新列舉值是 compatible。結構、列舉的變更列出經過的封包，沒有封包用到時降為 info。
- 結束碼：有 breaking 回 1、參數錯誤回 2；檔案無法讀取或沒通過檢查時和 `check` 一致回 1（和 breaking 同碼，要靠 stderr 區分）。
- 測試：`test/diff.test.ts` 每條規則一組小定義檔，`test/cli.test.ts` 驗文字、JSON 輸出與結束碼，範例在 `test/fixtures/diff-old.yaml`、`diff-new.yaml`。

- Wireshark dissector：`pktspec gen wireshark`，`--port` 設 TCP、UDP、伺服器連接埠偏好設定的預設值；輸出單一 `<name>.lua`（3.6 以上、無外部模組），欄位表由產生器寫成資料，Lua 端用一個小直譯器走過。
- 封包沒有長度前綴，所以不做 TCP 重組，一個 UDP 封包或 TCP 區段就是一則訊息；方向看伺服器連接埠，對不上就兩個方向都試解（試解用丟棄結果的假樹），平手當 c2s 並提示。
- 專家資訊：截斷、未知 opcode、未知列舉值、長度超出、巢狀過深（64 層）、尾端多餘資料、方向不明。
- 測試：golden file（`test/golden/wireshark/`）、`test/wireshark.test.ts`、`test/roundtrip-wireshark.test.ts`（測試內組 pcap，跑 `tshark -T fields` 比對欄位與專家資訊）；沒有含 Lua 的 `tshark` 時略過，`PKTSPEC_REQUIRE_TSHARK` 設定時改為失敗。CI 還沒裝 Wireshark，所以那邊略過。

## 刻意的限制

- 不支援 `bytes` 的陣列（各語言的相等比較會變複雜），請包成結構。
- 字串陣列的元素一律用 u16 長度前綴。
- 結構只能透過長度前綴陣列遞迴。
- TypeScript 的 `f32`、`f64` 寫出 NaN 時一律是標準 NaN，不保留原本的位元內容。
- `diff` 不偵測結構、列舉改名（視為移除加新增）；欄位改名只認同位置、同型別的情況；列舉值新增算相容，但產生的程式遇到未知值會丟錯。

- Wireshark：不重組 TCP；長度前綴的 u32 超過封包長度一律標成長度錯誤；沒有 `bytes` 陣列所以也不處理。

## 下一步

照 README 路線圖，下一版先做 C++ 產生器。`diff` 已完成，條件欄位進來後要補規則（目前格式沒有選填欄位）。
