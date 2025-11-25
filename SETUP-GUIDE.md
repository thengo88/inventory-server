# Hướng Dẫn Setup Google Sheets & Deploy Server

## Bước 1: Tạo Google Cloud Project và Service Account

### 1.1. Tạo Project
1. Truy cập: https://console.cloud.google.com/
2. Click **"Select a project"** → **"New Project"**
3. Đặt tên: `Inventory Management`
4. Click **"Create"**

### 1.2. Enable APIs
1. Vào **"APIs & Services"** → **"Library"**
2. Tìm và enable 2 APIs:
   - **Google Sheets API** → Click **"Enable"**
   - **Google Drive API** → Click **"Enable"**

### 1.3. Tạo Service Account
1. Vào **"APIs & Services"** → **"Credentials"**
2. Click **"Create Credentials"** → **"Service Account"**
3. Điền thông tin:
   - **Service account name:** `inventory-service`
   - **Service account ID:** (tự động)
4. Click **"Create and Continue"**
5. **Role:** Chọn `Editor` → Click **"Continue"** → **"Done"**

### 1.4. Tạo Key cho Service Account
1. Click vào service account vừa tạo
2. Tab **"Keys"** → **"Add Key"** → **"Create new key"**
3. Chọn **JSON** → Click **"Create"**
4. File JSON sẽ tự động download → **LƯU KỸ FILE NÀY!**
5. Đổi tên file thành: `service-account.json`
6. Copy file vào thư mục `excel-node-server/`

### 1.5. Lấy Service Account Email
1. Mở file `service-account.json`
2. Copy giá trị của `client_email` (dạng: `xxx@xxx.iam.gserviceaccount.com`)
3. **LƯU EMAIL NÀY** - sẽ dùng ở bước sau

---

## Bước 2: Tạo Google Sheet và Google Drive Folder

### 2.1. Tạo Google Sheet
1. Truy cập: https://sheets.google.com/
2. Tạo **Blank spreadsheet** mới
3. Đặt tên: `Inventory Data`
4. Tạo 2 sheets:
   - Sheet 1: Đổi tên thành `TonKho`
   - Sheet 2: Tạo mới và đặt tên `LichSu`

### 2.2. Share Sheet với Service Account
1. Click nút **"Share"** (góc trên bên phải)
2. Paste **Service Account Email** (từ bước 1.5)
3. Chọn quyền: **Editor**
4. **BỎ TICK** "Notify people" (vì đây là bot, không cần email)
5. Click **"Share"**

### 2.3. Lấy Google Sheet ID
1. Nhìn vào URL của Google Sheet:
   ```
   https://docs.google.com/spreadsheets/d/1ABC...XYZ/edit
                                          ^^^^^^^^
                                          ĐÂY LÀ SHEET ID
   ```
2. Copy phần giữa `/d/` và `/edit`
3. **LƯU SHEET ID NÀY**

### 2.4. Tạo Google Drive Folder
1. Truy cập: https://drive.google.com/
2. Tạo folder mới: `Inventory Images`
3. Click phải vào folder → **"Share"**
4. Paste **Service Account Email**
5. Chọn quyền: **Editor** → **"Share"**
6. Click vào folder, nhìn URL:
   ```
   https://drive.google.com/drive/folders/1ABC...XYZ
                                           ^^^^^^^^
                                           ĐÂY LÀ FOLDER ID
   ```
7. **LƯU FOLDER ID NÀY**

---

## Bước 3: Cấu Hình Local (Test trước khi deploy)

### 3.1. Tạo file .env
1. Trong thư mục `excel-node-server/`, tạo file `.env`
2. Paste nội dung sau và điền thông tin:

```env
# Google Sheets ID (từ bước 2.3)
GOOGLE_SHEETS_ID=PASTE_SHEET_ID_HERE

# Google Drive Folder ID (từ bước 2.4)
GOOGLE_DRIVE_FOLDER_ID=PASTE_FOLDER_ID_HERE

# Port
PORT=5000

# Environment
NODE_ENV=development
```

### 3.2. Test Local
```bash
cd excel-node-server
npm start
```

Kiểm tra:
- Server chạy thành công
- Truy cập: http://localhost:5000/admin
- Login: admin / admin123
- Thêm 1 sản phẩm
- Kiểm tra Google Sheet → Dữ liệu phải xuất hiện!

---

## Bước 4: Deploy lên Render.com (FREE)

### 4.1. Tạo GitHub Repository (nếu chưa có)
```bash
cd excel-node-server
git init
git add .
git commit -m "Initial commit with Google Sheets"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/inventory-server.git
git push -u origin main
```

### 4.2. Deploy trên Render.com
1. Truy cập: https://render.com/
2. Sign up (dùng GitHub account)
3. Click **"New +"** → **"Web Service"**
4. Connect GitHub repository
5. Chọn repository `inventory-server`
6. Cấu hình:
   - **Name:** `inventory-server`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** **Free**

### 4.3. Thêm Environment Variables
Trong phần **Environment**, thêm các biến sau:

1. **GOOGLE_SHEETS_ID**
   - Value: (Paste Sheet ID từ bước 2.3)

2. **GOOGLE_DRIVE_FOLDER_ID**
   - Value: (Paste Folder ID từ bước 2.4)

3. **GOOGLE_SERVICE_ACCOUNT_EMAIL**
   - Mở file `service-account.json`
   - Copy giá trị `client_email`
   - Paste vào đây

4. **GOOGLE_PRIVATE_KEY**
   - Mở file `service-account.json`
   - Copy **TOÀN BỘ** giá trị `private_key` (bao gồm cả `-----BEGIN PRIVATE KEY-----` và `-----END PRIVATE KEY-----`)
   - Paste vào đây (giữ nguyên format với `\n`)

5. **NODE_ENV**
   - Value: `production`

6. **SESSION_SECRET**
   - Value: `your_random_secret_key_here_123456`

### 4.4. Deploy
1. Click **"Create Web Service"**
2. Đợi 3-5 phút để deploy
3. Sau khi deploy xong, bạn sẽ có URL dạng:
   ```
   https://inventory-server-xxxx.onrender.com
   ```

### 4.5. Test Server
1. Truy cập: `https://inventory-server-xxxx.onrender.com/admin`
2. Login: admin / admin123
3. Thêm sản phẩm → Kiểm tra Google Sheet

---

## Bước 5: Cập Nhật Flutter App

### 5.1. Tìm file cấu hình API
File: `inventory_app/lib/services/inventory_manager.dart`

### 5.2. Thay đổi URL
Tìm dòng có `baseUrl` hoặc IP address (dạng `192.168.x.x:5000`)

Thay bằng:
```dart
final String baseUrl = 'https://inventory-server-xxxx.onrender.com';
```

### 5.3. Build lại Flutter App
```bash
cd inventory_app
flutter clean
flutter pub get
flutter build windows
```

---

## ✅ Hoàn Tất!

Bây giờ:
- ✅ Server chạy 24/7 trên Render.com (miễn phí)
- ✅ Dữ liệu lưu trên Google Sheets (tự động backup)
- ✅ Hình ảnh lưu trên Google Drive (15GB miễn phí)
- ✅ Có thể truy cập từ bất kỳ đâu
- ✅ Không cần mở máy tính

---

## 🔧 Troubleshooting

### Lỗi: "Google credentials not found"
→ Kiểm tra lại environment variables trên Render.com

### Lỗi: "Permission denied" khi ghi Google Sheets
→ Kiểm tra lại đã share Sheet với service account email chưa

### Server sleep sau 15 phút không dùng (Free tier)
→ Bình thường, lần đầu truy cập sẽ mất 30s để wake up

### Cần giữ server luôn active?
→ Dùng UptimeRobot (free) để ping server mỗi 5 phút

---

## 📞 Hỗ Trợ

Nếu gặp vấn đề, check logs trên Render.com:
1. Vào Dashboard → Chọn service
2. Tab **"Logs"**
3. Xem lỗi và báo lại
