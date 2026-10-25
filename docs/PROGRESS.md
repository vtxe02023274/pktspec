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
- `<Name>Codec` 只在協定有列舉時 import `InvalidPacketError`、`PacketReader`（只有列舉的讀取函式用到），否則 `noUnusedLocals` 編不過。四種語言的往返測試都跑 `test/fixtures/minimal.yaml`（單一 `u8` 欄位，沒有列舉、結構、位元欄位、條件，伺服器方向沒有封包）；另外手動確認過沒有封包、空封包、只有結構、只有位元欄位與條件、列舉只在位元欄位、只有列舉沒有封包等最小協定，Java `-Xlint:all -Werror`、C# `-warnaserror`、C++ `-Wshadow` 都沒有警告。
- 測試：golden file（`test/golden/typescript/`）、TypeScript 往返測試（用專案的 `tsc` 以嚴格選項編進暫存目錄，含 `noUncheckedIndexedAccess`、`noUnusedLocals`、`verbatimModuleSyntax`、`erasableSyntaxOnly`，再用 Node 執行，逐一編碼再解碼，比對已知位元組，另驗證範圍、截斷與錯誤輸入）；不需要額外工具，所以沒有略過條件。

- C++ 產生器：`pktspec gen cpp`，`--namespace` 指定命名空間（接受 `A::B` 或 `A.B`，預設由協定名稱轉 PascalCase）；C++17，只用標準函式庫，純標頭檔，不需要連結。
- 選純標頭檔：丟進伺服器、Unreal 或 Unity 原生外掛只要加 include 路徑，不用管編譯單元；代價是編譯時間，函式都標 `inline`。檔案不分子目錄：`Packet`、`PacketReader`、`PacketWriter`、`PacketErrors`、`<Name>Protocol`，列舉、封包各一個，結構全放 `Structs.hpp`（兩個結構可用陣列互相包含，每型別一個標頭排不出可編譯的 include 順序，所以宣告與定義拆開、所有結構一起宣告）。
- 分派回傳 `std::unique_ptr<Packet>`（基底類別有 `opcode()`、`bodySize()`、`writeTo()`、`encode()`），不用 `std::variant`：某個方向可能沒有封包（空 `variant` 不合法）、伺服器常把封包排進佇列、各語言的分派形狀一致；代價是每個封包一次堆積配置。
- 與其他語言的差異：欄位 camelCase，和 C++ 保留字、`min`、`max` 等巨集名稱或產生的成員衝突就補底線；整數用 `<cstdint>`，不做範圍檢查；字串是 `std::string`，位元組原樣收發不驗 UTF-8；固定長度陣列與位元組是 `std::array`，所以沒有元素數錯誤；沒有 `hashCode`、`toString`，`operator==` 把 NaN 視為相等（和 C# 一致）。
- 位元組順序：逐位元組組合與拆開，浮點數用 `memcpy`，有號數轉換自己拆開寫，不靠實作定義的行為。
- 錯誤都繼承 `std::runtime_error`：`PacketError` 為基底；`TruncatedPacketError`、`InvalidPacketError`（長度超過 2^31 - 1；子類別 `UnknownOpcodeError`、`UnknownEnumValueError`）、`PacketRangeError`（寫入時長度前綴放不下）。需要開啟例外。
- 型別名稱和產生的名稱（`Packet`、`Structs` 等）或 `NULL`、`ERROR` 這類常被定義成巨集的名稱衝突（不分大小寫）直接報錯。文件註解用區塊註解並且只輸出 ASCII（非 ASCII 寫成 `\uXXXX`），避免行尾反斜線接行和 MSVC 的原始碼字碼頁問題。
- 測試：golden file（`test/golden/cpp/`）、`test/cpp.test.ts`、`test/roundtrip-cpp.test.ts`（用 `g++`／`clang++`／`cl`，或 `CXX` 指定，以 `-std=c++17 -Wall -Wextra -Werror -pedantic -Wshadow` 編譯產生的標頭加產生的測試程式再執行：每個封包的極端值編碼再解碼、比對已知位元組、每個長度的截斷、錯誤輸入與寫入範圍的例外，另有結構互相包含、關鍵字欄位名稱、和產生的區域變數同名的欄位的協定）；沒有編譯器時略過，`PKTSPEC_REQUIRE_CPP` 設定時改為失敗。也用 MSVC `/W4 /WX` 與 g++ 的 `-Wshadow -Wconversion -std=c++20` 手動確認過。產生的函式裡的區域變數與參數（`size_`、`item_`、`writer_`、`other_`、`<名稱>Bits_`、`<名稱>Present_`、`<名稱>Count_`）一律以底線結尾：成員只有和關鍵字或保留名稱衝突時才會補底線，所以欄位叫 `size`、`flags_bits` 也不會被遮蔽。

- `pktspec diff old.yaml new.yaml`：比對兩份定義，依 breaking／compatible／info 分組，`--format json` 給程式讀；兩個檔案都先過 `check` 的檢查，錯誤一起列出。`compile` 多回傳 `locations`（宣告位置），`src/diff.ts` 用它標行號。
- diff 規則依線上格式（opcode 加依序欄位，無名稱）：欄位新增、移除、型別或長度前綴改變、列舉底層型別改變、值移除或改號一律 breaking；改名、doc、version 是 info；新封包、新列舉值是 compatible。結構、列舉的變更列出經過的封包，沒有封包用到時降為 info。
- 結束碼：有 breaking 回 1、參數錯誤回 2；檔案無法讀取或沒通過檢查時和 `check` 一致回 1（和 breaking 同碼，要靠 stderr 區分）。
- 測試：`test/diff.test.ts` 每條規則一組小定義檔，`test/cli.test.ts` 驗文字、JSON 輸出與結束碼，範例在 `test/fixtures/diff-old.yaml`、`diff-new.yaml`。

- Wireshark dissector：`pktspec gen wireshark`，`--port` 設 TCP、UDP、伺服器連接埠偏好設定的預設值；輸出單一 `<name>.lua`（3.6 以上、無外部模組），欄位表由產生器寫成資料，Lua 端用一個小直譯器走過。
- 封包沒有長度前綴，所以不做 TCP 重組，一個 UDP 封包或 TCP 區段就是一則訊息；方向看伺服器連接埠，對不上就兩個方向都試解（試解用丟棄結果的假樹），平手當 c2s 並提示。
- 專家資訊：截斷、未知 opcode、未知列舉值、長度超出、巢狀過深（64 層）、尾端多餘資料、方向不明。
- 測試：golden file（`test/golden/wireshark/`）、`test/wireshark.test.ts`、`test/roundtrip-wireshark.test.ts`（測試內組 pcap，跑 `tshark -T fields` 比對欄位與專家資訊）；沒有含 Lua 的 `tshark` 時略過，`PKTSPEC_REQUIRE_TSHARK` 設定時改為失敗。CI 還沒裝 Wireshark，所以那邊略過。

- `pktspec fuzz <file> -o <dir>`：`--seed`、`--count`、`--max-size`、`--max-samples`；輸出 `valid/`、`invalid/`、`manifest.json`（格式見 README）。實作在 `src/fuzz.ts`，不依賴任何產生器，直接依 `model.ts` 的線上格式組位元組。
- 有效樣本：整包 zero／min／max，再逐一欄位換邊界值（其他欄位為 0）；隨機樣本用自己的 mulberry32，每個封包獨立亂數序列（種子加方向加封包名），位元組相同的樣本去重。
- 無效樣本與標的錯誤只有兩類，各語言對得起來：`truncated`（截斷、長度前綴超出剩餘位元組）對 `TruncatedPacketError`／`BufferUnderflowException`／`EndOfStreamException`，`invalid`（未知 opcode、未知列舉值、`u32` 長度超過 2^31 - 1）對 `InvalidPacketError`／`IllegalArgumentException`／`InvalidDataException`。
- 不產生尾端多餘位元組、`bool` 非 0/1、不合法 UTF-8：四個解碼器都不拒絕，標了就是錯的。
- 遞迴結構在第 3 層停止；固定長度陣列只換第一個元素；陣列長度前綴的最大值放不進 `--max-size` 時改填到放得下為止（檔名 `fill`）；元素大小為 0 的陣列（`Empty[]`）最多 1024 個，也不產生 `length_past_end`（解碼不會到達尾端）。
- 輸出目錄已有 `manifest.json` 時先刪舊的 `valid/`、`invalid/`。
- 測試：`test/fuzz.test.ts`（決定性、邊界位元組、無效標籤、上限選項）、`test/roundtrip-fuzz.test.ts`（TypeScript、Java、C#、C++ 解碼器吃整份語料：有效的解開且重新編碼位元組不變，無效的丟出標的錯誤；Java、C#、C++ 的略過與 `PKTSPEC_REQUIRE_*` 規則同往返測試）、`test/cli.test.ts`。Wireshark 沒有跑語料。

- 位元欄位：欄位加 `bits` 清單，`type` 是底層整數（`u8`／`u16`／`u32`，照協定 endian 讀寫）；子欄位 `{ name, type?, bits? }`，`type` 省略是無號整數、`bool` 固定 1 位元、列舉要寫 `bits`。從最低位元開始排，總和不得超過底層寬度，剩下的位元寫 0、讀時忽略。模型是 `FieldType` 多一種 `{ kind: 'bits', base, fields }`；`memberFields()` 把群組攤平成一般成員給產生器用（`MemberField`、`MemberType` 排除 `bits`，型別系統保證成員不會是群組），`bitLayout()` 給位移。
- 選語法時把群組當成一個有名稱的欄位，而不是讓子欄位直接平鋪在 `fields`：底層整數的寬度、未使用的位元、文件與 Wireshark 的父節點、`diff` 的比對單位都需要一個名字。群組名稱和子欄位、同層欄位共用命名空間（`check` 一起比對 camelCase 後的名稱），產生的程式碼裡不出現群組名稱。
- `check`：位元數至少 1、`bool` 只能 1 位元、總和不超過底層寬度、列舉的每個值都要在 0 到 2^bits - 1（所以負值列舉不能放）、子欄位型別只能是 `bool` 或列舉、底層型別只能是 `u8`／`u16`／`u32`、不能和 `length`／`size` 一起用、不能是陣列。列舉先於結構與封包解析，所以子欄位能檢查列舉值。
- 成員型別：無號子欄位用放得下的最小無號型別（≤8 位元當 `u8`、≤16 當 `u16`、其餘 `u32`），所以 Java 的 7 位元是 `short`、C# 是 `byte`。各語言都用一個區域變數組合整數再寫出：Java `long`、C# `uint`、C++ `std::uint32_t`、TypeScript `number`（位元運算是有號 32 位元，`u32` 寫出前 `>>> 0`，讀取時碰到第 31 位元的子欄位不再做遮罩）。
- 範圍錯誤：各語言的 codec 多一個 `checkBits`，只在協定有位元欄位時產生（沒有位元欄位的協定 golden 不變）：Java 丟 `IllegalArgumentException`、C# `ArgumentException`、TypeScript `RangeError`、C++ `PacketRangeError`。C# 與 C++ 列舉可以強制轉型成任意值，所以列舉子欄位也過一次檢查：C# 負值轉成無號後必定超出，C++ 的 `checkBits` 收 `std::int64_t` 並直接拒絕負值（子欄位佔滿 32 位元時轉成無號不會超出）；TypeScript 同理；Java 列舉值在 `check` 已保證放得下，但為了統一也走 `checkBits`。
- 解碼列舉子欄位：Java 沿用 `fromValue`；TypeScript、C#、C++ 為位元欄位用到的列舉多產生 `bitsTo<Enum>`（吃數值而不是讀取器），錯誤類別與一般列舉欄位相同。
- Wireshark：群組是十六進位的整數欄位，子欄位是同寬度、帶遮罩的 `ProtoField`（`bool` 用 `ProtoField.bool` 加位元寬度），名稱和一般欄位一樣是 `協定.封包.子欄位`。列舉值的檢查在 Lua 端用 `math.floor(raw / div) % mod`，不依賴 `bit32` 或 5.3 的位元運算子。執行期的 `bits` 分支同樣只在用到時產生。
- 文件：欄位表的型別寫 `u16 bit fields`，表後另有一張位元範圍表（`1–2` 這種寫法，包含未使用的位元範圍）。
- `diff`：同位置、同底層整數的位元欄位群組算改名，子欄位另外比對（群組改名同時新增子欄位是一筆 info 加一筆 compatible，而不是移除加新增）。子欄位先依名稱配對，再依位置配對改名。位元數改變（`bit-field-resized`）、位置改變含順序（`bit-field-moved`）、型別改變（`bit-field-type-changed`）、移除（`bit-field-removed`）都是 breaking；改名、doc 是 info。新增子欄位：落在舊版未使用的高位元是 compatible，理由是舊版寫入時那些位元必定是 0、讀取時忽略，新版讀舊資料得到 0，雙方都不會失敗；例外是沒有 0 值的列舉，新版讀舊資料會丟錯，算 breaking；佔到舊版已用位元的也是 breaking。移除不對稱地算 breaking：舊版的程式還在讀那幾個位元，卻只會收到 0，語意被默默改掉。只被位元欄位用到的列舉，底層型別改變不影響線上格式，降為 info。
- `fuzz`：有效樣本逐一把子欄位換成最大值（`bool` 為 true、列舉每個值），0 由 `zero` 樣本涵蓋；未使用的位元一律為 0（解碼會忽略、重新編碼寫 0，非 0 的樣本既不是有效也不會丟錯，所以不產生）。無效樣本 `unknown_enum` 多了列舉子欄位：在位元數放得下的範圍內取沒有成員使用的最大與最小值，放不下任何未使用值時不產生。
- 測試：`test/fixtures/bit-fields.yaml`（三種寬度、沒有 0 值且底層為 `i16` 的列舉、佔滿 32 位元、第 31 位元、結構裡的位元欄位與結構陣列）；`compile.test.ts` 的錯誤訊息；各產生器 golden；Java、C#、TypeScript、C++ 往返（已知位元組、超出位元數的範圍錯誤、未知列舉值、未使用位元被忽略）；Wireshark 用 tshark 比對遮罩欄位、列舉專家資訊與截斷；fuzz 單元測試與四種解碼器的語料交叉驗證；`diff.test.ts` 每條規則。另外手動用 g++ `-std=c++20 -Wshadow -Wconversion -Wsign-conversion` 與 MSVC `/W4 /WX` 編譯過產生的標頭。

- 條件欄位：欄位加 `if`。`if: flag` 測 `bool` 為 true；`if: { field: kind, equals: A }`、`if: { field: kind, in: [A, B] }` 測整數或列舉。沿用欄位上的一個鍵，不另開區塊：條件屬於單一欄位，和 `length`、`size` 一樣寫在欄位上最好讀；`bool` 的簡寫是最常見的「有旗標才有資料」。模型是 `Field.condition`（`{ kind: 'true' }` 或 `{ kind: 'in', values }`），列舉值在 `check` 時就換成數字，產生器與 `diff` 只看線上的值。`MemberField` 也帶 `condition`：位元欄位群組的條件由 `bitMember(bit, condition)` 帶給每個子欄位（另一個快取，物件一樣固定，C#、TypeScript、C++ 用它當名稱表的鍵）；`conditionTarget()` 找被測的成員。
- `check`：被測欄位要在前面（後面的、自己、不存在的各有訊息，不存在的附大小寫建議）；型別只能是 `bool`、整數、列舉或位元欄位的子欄位，群組名稱本身不行；`bool` 只能用簡寫，整數與列舉一定要給值；列舉值要是成員名稱，整數要在型別範圍內，位元欄位在位元數內；`u64`、`i64` 限 ±(2^53 - 1)，因為值存成 JavaScript 的 number，Wireshark 端也用 `tonumber()` 比對，這個範圍內都精確。被測欄位本身沒編譯過時不再多報一個錯。
- 被測欄位本身是條件欄位：支援，它不存在時條件一律不成立。理由是「有公會 → 公會有徽章 → 徽章資料」這種一層層的選填資料很常見；各語言比較空值都很便宜：Java 的列舉 `==` 本來就安全，`Boolean.TRUE.equals(x)`、`x != null && x == 3`；C# 的 nullable 比較會提升；TypeScript 的 `===` 對 `undefined` 為 false；C++ 的 `std::optional == 值` 在空的時候為 false。
- 產生的程式碼：Java 用包裝型別而不是 `Optional`（`Optional` 不建議當欄位、不能序列化，產生的類別又是公開欄位，用包裝型別讀寫方式和其他欄位一樣），C# 是 `T?`，TypeScript 是 `T | undefined`，C++ 是 `std::optional<T>`；預設都是空值，不給一般欄位的預設值。
- 寫入：每個條件欄位先算出 `<名稱>Present`，每個成員過一次 `checkPresent`（位元欄位群組逐一檢查子欄位），再寫入。錯誤沿用各語言既有的寫入錯誤：Java `IllegalArgumentException`、C# `ArgumentException`、TypeScript `RangeError`、C++ `PacketRangeError`，沒有新增錯誤類別。`checkPresent` 只在協定有條件欄位時產生，C# 與 TypeScript 另加 `OptionalEqual`／`optionalEqual` 給位元組、陣列、結構的相等比較，C++ 加 `detail::same` 的 `std::optional` 版本，所以沒有條件欄位的協定 golden 不變。
- `bodySize` 依欄位有沒有值計算，而不是依條件：條件成立卻沒值時，大小計算不會先碰到空值，錯誤統一由寫入報；前面的欄位都一致，所以報錯前不會寫超出緩衝區。位元欄位群組以第一個子欄位判斷。寫入時取值：C# 值型別用 `GetValueOrDefault()`、參考型別加 `!`，TypeScript 加 `!`，C++ 用 `*`，都在 `checkPresent` 之後。C++ 讀取條件陣列先 `emplace()` 再就地填。
- 結構可以經由條件陣列遞迴（`Node` 的 `children` 是 `std::optional<std::vector<Node>>`），g++、MSVC 都能編。
- Wireshark：被測的欄位在欄位表多 `key`（有號數加 `signed`），位元欄位群組有被測的子欄位時加 `keys` 並在子欄位上記 `key`、`div`、`mod`；條件欄位有 `cond = { f, v }`。執行期的 `dissect_fields` 在協定有條件欄位時換成會記值的版本，每個結構或封包一張值表；64 位元的值用 `Int64:tonumber()`，比對範圍見上。
- 文件：有條件欄位的表格多一欄 `Present when`，整份文件開頭多一句說明；大小欄寫條件成立時的大小，封包總大小因此變成 `N+`。
- `diff`：加上（`condition-added`）、移除（`condition-removed`）、改變（`condition-changed`）條件都是 breaking，因為雙方對這幾個位元組在不在線上的判斷不同。比對時被測欄位沿用欄位的配對（依名稱，再依位置與型別認改名；子欄位再依群組內的配對），值依集合比較，所以被測欄位改名、前面的位元欄位群組多了子欄位、列舉成員改名、`in` 換順序都不算改變；不用攤平後的成員序號，因為群組多一個子欄位會讓後面的序號全部位移。結構的線上簽章也帶條件（被測成員所在欄位的位置，子欄位再加群組內的位置，加上值），改條件的結構會影響改名與排列判斷。新增條件欄位一般是 breaking（條件成立時後面的位元組位移）；例外是條件只比對舊版沒有定義的列舉值，而且被測欄位在舊版已是同一個列舉：舊版不會送出這些值、舊資料也不會讓條件成立，和新增列舉值同一個理由算 compatible。移除條件欄位一律 breaking，舊版在條件成立時還會讀那幾個位元組。
- `fuzz`：欄位串列改成依條件組合（`place()`），被測的值從已編好的位元組讀回，不需要另外帶值；整包樣本、巢狀結構、隨機樣本都照條件決定欄位在不在，條件不成立的欄位不消耗亂數。逐一換邊界值時，條件欄位先把被測欄位設成符合的第一個值（被測欄位也有條件就一路往前設），所以條件欄位的每個邊界值、列舉的未知值、長度前綴都涵蓋得到；另外加 `present`（條件成立、欄位為 0）與 `absent`（被測欄位換成不符合的值）兩個樣本，和既有樣本位元組相同的照常去重。無效樣本多一種 `truncated`：封包層的條件欄位在條件成立時，從該欄位開始整個截掉（`missing-<欄位>`）。沒有條件欄位的協定，語料與之前逐位元組相同（用舊版 `fuzz.ts` 比對過三個既有 fixture 與兩組選項）。
- 測試：`test/fixtures/conditional-fields.yaml`（列舉的 `equals`／`in`、`bool`、位元欄位的 `bool`、無號與列舉子欄位、有條件的位元欄位群組、測條件欄位的條件、負數與 `u64` 的值、條件陣列、固定長度陣列、經由條件陣列遞迴的結構）；`compile.test.ts` 的解析結果與錯誤訊息；各產生器 golden（既有的 golden 沒有變動）；Java、C#、TypeScript、C++ 往返（極端值的兩種排列、已知位元組、條件成立卻沒值、條件不成立卻有值、位元欄位群組只給一半、解碼後保持空值）；Wireshark 用 tshark 比對欄位有無、串連的條件、64 位元條件的邊界值與多餘位元組；fuzz 單元測試與四種解碼器的語料交叉驗證；`diff.test.ts` 每條規則。另外手動用 g++ `-std=c++20 -Wshadow -Wconversion -Wsign-conversion` 與 MSVC `/W4 /WX` 編譯過產生的標頭。

## 刻意的限制

- 不支援 `bytes` 的陣列（各語言的相等比較會變複雜），請包成結構。
- 位元欄位不能當陣列元素（每個元素要攤平成多個成員，各語言都得另造一個型別），請包成結構再用結構陣列。底層只有 `u8`／`u16`／`u32`，子欄位只有無號整數、`bool`、非負值的列舉，沒有有號子欄位。
- 位元欄位未使用的位元解碼時不檢查，重新編碼一律寫 0，所以收到非 0 的保留位元時重新編碼結果會不同。
- 條件只能測同一層、前面的欄位，不能測巢狀結構裡的欄位，也不能有 `and`／`or`、比大小或 `bool` 為 false；陣列元素不能各自帶條件。`bool` 為 false 的情況可以把旗標反過來定義。
- 條件的整數值限 ±(2^53 - 1)，`u64`、`i64` 再大的值不能當條件。
- `fuzz` 的 `missing` 樣本只做封包層的條件欄位；巢狀結構裡的條件欄位靠整包截斷與邊界值涵蓋。
- 字串陣列的元素一律用 u16 長度前綴。
- 結構只能透過長度前綴陣列遞迴。
- TypeScript 的 `f32`、`f64` 寫出 NaN 時一律是標準 NaN，不保留原本的位元內容。
- `diff` 不偵測結構、列舉改名（視為移除加新增）；欄位改名只認同位置、同型別的情況（位元欄位群組只看底層整數）；列舉值新增算相容，但產生的程式遇到未知值會丟錯。

- C++：沒有 `hashCode`、`toString`；例外關閉的環境（Unreal 預設）不能用；`PacketReader` 不擁有緩衝區，緩衝區要比它活得久；長度為 0 位元組的結構組成的長陣列（例如 `Empty[]` 宣告 2^31 - 1 個）會讓解碼迴圈跑很久，其他語言一樣。
- Wireshark：不重組 TCP；長度前綴的 u32 超過封包長度一律標成長度錯誤；沒有 `bytes` 陣列所以也不處理。

## 下一步

README 路線圖已全部完成。之後若要擴充條件，可以從 `Condition` 加新的 `kind`（例如 `bool` 為 false、不等於），compile、各產生器的 `condition()`、Wireshark 的 `holds()`、fuzz 的 `holds()`／`satisfy()`／`fail()` 與 `diff` 的 `sameCondition()` 要一起改。
