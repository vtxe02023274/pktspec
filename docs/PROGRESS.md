# 進度

## 0.1.0

- 定義檔：`name`、`version`、`endian`、`opcode`（u8／u16）、`enums`、`structs`、`packets`。
- `check`：YAML 語法、缺少或未知的鍵、名稱重複（封包、結構、列舉共用命名空間）、同方向 opcode 重複、未定義型別（含大小寫建議）、`length`／`size` 用錯、數值範圍、結構自我包含。錯誤都帶行號與欄位。
- Java 產生器：只用 `java.nio.ByteBuffer`，Java 8 可編譯；每個封包一個類別，`<Name>Protocol` 依方向與 opcode 分派；寫入時檢查範圍與長度。
- 文件產生器：Markdown，封包總表＋每個封包、結構、列舉的欄位表。
- 測試：Vitest 單元測試、golden file（`test/golden/`）、Java 往返測試（`javac -Werror` 編譯後逐一編碼再解碼，並比對已知位元組）。

## 刻意的限制

- 不支援 `bytes` 的陣列（各語言的相等比較會變複雜），請包成結構。
- 字串陣列的元素一律用 u16 長度前綴。
- 結構只能透過長度前綴陣列遞迴。

## 下一步

照 README 路線圖，下一版先做 C# 產生器。
