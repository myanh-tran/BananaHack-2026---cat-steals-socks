# HƯỚNG DẪN VÀ GIẢI THÍCH CHI TIẾT CODE JAVASCRIPT (BẢN NÂNG CẤP HACKATHON)

Tài liệu này giải thích chi tiết mục đích, luồng hoạt động và chức năng của từng khối mã nguồn (line-by-line) trong 2 file JavaScript:
1. `js/canvas.js` (Bao gồm sa bàn 30 ô đỗ xe, 3 trạng thái FREE/OCCUPIED/RESERVED, thang máy, vật cản, và thuật toán A* điều phối thông minh)
2. `js/main.js` (Bao gồm tầng điều khiển, cờ USE_MOCK, bộ chuyển 8 kịch bản test, upload ảnh thật và polling 3s)

---

## PHẦN 1: TỔNG QUAN KIẾN TRÚC & QUY MÔ SA BÀN 30 Ô

- **Quy mô thực tế:** Không còn giới hạn 12-16 ô nhỏ nữa, bãi xe được chuẩn hóa gồm **30 ô đỗ xe** phân chia thành 5 phân khu rõ ràng:
  - **Tòa A:** 6 ô cư dân (`A-01` .. `A-06`) cạnh Thang máy Tòa A (`ELV-A`).
  - **Tòa B:** 6 ô cư dân (`B-01` .. `B-06`) cạnh Thang máy Tòa B (`ELV-B`).
  - **Khu xe khách G:** 6 ô riêng (`G-01` .. `G-06`) nằm tại trung tâm bãi xe để đón khách vãng lai.
  - **Tòa C:** 6 ô cư dân (`C-01` .. `C-06`) cạnh Thang máy Tòa C (`ELV-C`).
  - **Tòa D:** 6 ô cư dân (`D-01` .. `D-06`) cạnh Thang máy Tòa D (`ELV-D`).
- **3 trạng thái ô đỗ trực quan:**
  1. `FREE` (Màu xanh lá): Ô đang trống, sẵn sàng nhận xe.
  2. `RESERVED` (Màu vàng hổ phách / Gold `#f59e0b`): Ô **đã được cấp cho xe vừa qua cổng**. Xe sau vào cổng sẽ **tuyệt đối không bị cấp trùng** ô này!
  3. `OCCUPIED` (Màu đỏ): Xe đã vào đỗ hoàn tất.

---

## PHẦN 2: GIẢI THÍCH CHI TIẾT FILE `js/canvas.js`

### 1. Hàm khởi tạo 30 ô đỗ xe `buildCampusSlots()`
- Tự động dựng 30 ô dựa trên mảng cấu hình `defaultCampusZones` (hoặc file `parking_map.json`).
- Mỗi ô chứa đầy đủ: `id`, đỉnh đa giác `coordinates`, tâm `center`, phân khu `zone` ("A", "B", "C", "D", "G"), loại `type` ("resident" hoặc "guest").

### 2. Cơ chế giữ chỗ `reserveSlot(slotId, plateNumber)`
```javascript
function reserveSlot(slotId, plateNumber = '') {
  const target = activeParkingSlots.find((s) => s.id === slotId);
  if (target) {
    target.isReserved = true;
    target.occupied = true; // Tính là không còn khả dụng cho xe khác
    target.reservedPlate = plateNumber;
    initParkingMap();
  }
}
```
- Khi một xe nhận ô, cờ `isReserved` được bật lên ngay lập tức. Ô xe đổi sang màu vàng hổ phách và không bao giờ xuất hiện trong danh sách tìm kiếm của xe tiếp theo.

### 3. Thuật toán điều phối ô đỗ thông minh `assignOptimalParkingSlot()`
Xử lý toàn diện mọi tình huống thực tế của bãi xe:
1. **Kiểm tra bãi đầy 100% (`isParkingLotFull()`):**
   - Nếu không còn bất kỳ ô nào trống $\to$ Trả về `status: 'FULL'`, barrier không mở.
2. **Xe cư dân (`type === 'resident'`):**
   - Ưu tiên 1: Quét các ô trống trong chính tòa nhà của cư dân đó (ví dụ Tòa A) và chọn ô **gần Thang máy Tòa A nhất**.
   - **Xử lý Tòa nhà đầy 100% (Overflow):** Nếu Tòa A đã kín sạch 6 ô, thuật toán không báo lỗi mà tự động quét các ô trống ở các tòa lân cận (B, C, D, G) sao cho **khoảng cách đi bộ về Thang máy Tòa A là ngắn nhất**, trả về thông báo:
     *"Tòa A đã đầy! Đã điều phối sang ô G-02 (cách thang máy Tòa A ~49m)"*.
3. **Xe khách vãng lai (`type === 'guest'`):**
   - Ưu tiên 1: Cấp ô trong Khu khách riêng (`G-01` .. `G-06`).
   - Nếu Khu G đã đầy: Cấp ô trống gần nhất ở các tòa lân cận.

### 4. Thuật toán A* né vật cản & Vẽ tuyến đường
- `buildNavigationGrid()`: Đánh dấu các cột trụ bê tông `P1-P4`, vùng thi công `🚧` và tất cả các ô có xe/đã giữ chỗ thành vật cản (chỉ mở ô đích đến).
- `drawRoutingPath()`: Vẽ nét vàng neon A* cho xe ô tô né cột trụ vào ô đỗ, đồng thời vẽ nét đứt màu xanh ngọc (`🚶`) nối từ ô đỗ đến sảnh thang máy kèm biển cự ly đi bộ.

---

## PHẦN 3: GIẢI THÍCH CHI TIẾT FILE `js/main.js`

### 1. Tầng dữ liệu & Cờ `USE_MOCK`
- Cung cấp dropdown chuyển đổi trên thanh Header:
  - **Mock Data (`USE_MOCK = true`):** Dùng để test demo 8 kịch bản nhanh chóng mà không phụ thuộc backend.
  - **Live Server (`USE_MOCK = false`):** Kết nối trực tiếp tới `http://localhost:8000`.

### 2. Bộ nạp 8 kịch bản Test (Mục 9 Kế hoạch)
Cho phép ban giám khảo và nhóm kiểm thử mọi tình huống biên:
1. `normal`: Bình thường (còn nhiều chỗ).
2. `zone_a_full`: Tòa A kín 100% $\to$ tự động điều phối xe cư dân Tòa A sang ô khác.
3. `guest_zone_full`: Khu xe khách G kín 100%.
4. `lot_full`: Cả bãi xe kín 100% $\to$ Cổng từ chối mở, hiện cảnh báo đỏ.
5. `only_one_slot`: Toàn bãi chỉ còn đúng 1 ô duy nhất (`D-06`).
6. `resident_building_b`: Cư dân Tòa B.
7. `ocr_unreadable`: Lỗi OCR `PLATE_UNREADABLE`.
8. `ocr_no_vehicle`: Lỗi OCR `NO_VEHICLE`.

### 3. Hỗ trợ Upload ảnh xe thật
- Nút **"📁 Tải ảnh xe"** cho phép chọn file ảnh JPG/PNG từ máy tính.
- Ảnh xe sẽ hiển thị trực tiếp trong khung Camera cổng vào (`cameraPreviewImg`) và gửi lên API nhận diện.

### 4. Vòng lặp Polling 3 giây (`startPolling()`)
- Khi kết nối Live Server (`USE_MOCK = false`), hàm `setInterval` tự động gọi:
  - `GET /api/health`: Kiểm tra server sống và model đã load xong chưa.
  - `GET /api/slots`: Cập nhật trạng thái occupied của 30 ô xe theo thời gian thực từ camera AI.
