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

## 刻意的限制

- 不支援 `bytes` 的陣列（各語言的相等比較會變複雜），請包成結構。
- 字串陣列的元素一律用 u16 長度前綴。
- 結構只能透過長度前綴陣列遞迴。

## 下一步

照 README 路線圖，下一版先做 TypeScript 產生器。
