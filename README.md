# Crypto Intelligence System — versi web

Sistem riset crypto berbasis narasi untuk **Binance Spot (USDT, long-only)**: universe, narasi, attention, capital flow, screener kuantitatif, price action & SMC, sinyal, manajemen risiko, portofolio, journal, uji historis, watchlist, dan alarm momentum.

Versi ini adalah salinan statis dari aplikasi artifact Claude, dan bisa di-host di GitHub Pages. Kode aplikasinya sama persis. Yang berbeda hanya `shim.js`, yang menggantikan runtime artifact (konektor dan database) dengan API publik dan penyimpanan browser.

> **Hanya data pasar.** Aplikasi tidak meminta, tidak menyimpan, dan tidak memakai API key akun Binance, dan tidak bisa menempatkan order. Ini alat riset, bukan saran keuangan. Uji historis terakhir untuk aturan sinyal masih menyatakan **NO EDGE**, sehingga BUY tetap diblokir.

## Menjalankan di GitHub Pages

1. Buat repository baru di GitHub, misalnya `crypto-intelligence-system`.
2. Upload isi folder ini ke root repository: `index.html`, `engine.js`, `shim.js`, `.nojekyll`, dan `README.md`.
3. Buka **Settings → Pages**. Di bagian *Build and deployment*, pilih **Deploy from a branch**, lalu branch `main` dengan folder `/ (root)`.
4. Tunggu 1–2 menit. Aplikasi akan tersedia di `https://<username>.github.io/<nama-repo>/`.

Untuk mencoba di komputer sendiri, jalankan web server statis apa pun di folder ini, misalnya `python3 -m http.server 8000`, lalu buka `http://localhost:8000`. Aplikasi tidak bisa dijalankan dengan membuka `index.html` langsung dari file, karena browser memblokir beberapa fitur di `file://`.

## Sumber data

| Sumber | Dipakai untuk | Key |
|---|---|---|
| Binance `data-api.binance.vision` | exchangeInfo, ticker 24 jam, candle, order book, aggTrades (arus beli/jual taker) | tidak perlu |
| Binance WebSocket `data-stream.binance.vision` | harga semua pair realtime (sekitar 1 detik) dan candle live di chart Price Action & SMC | tidak perlu |
| CoinGecko API gratis | daftar coin dan kontrak, ranking market cap, kategori coin untuk narasi | opsional (Demo key gratis menaikkan batas) |
| Etherscan API v2 | transfer token ERC-20 untuk metrik on-chain | key gratis sendiri, diisi di ⚙ Web |

Perbedaan dibanding versi artifact:
- **Harga realtime lewat WebSocket.** Satu sambungan ke stream `!miniTicker@arr` membawa harga terakhir semua pair kira-kira setiap detik. Harga di tabel dan kartu sinyal berkedip hijau/merah saat berubah, dan bilah atas menampilkan **● LIVE**. Chart Price Action & SMC juga menerima candle live untuk pair dan timeframe yang sedang dibuka. Kalau sambungan putus, aplikasi menyambung ulang otomatis (2 detik, naik sampai 60 detik) dan sementara itu kembali ke polling REST.
- **aggTrades berfungsi.** Di artifact, sumber ini diblokir kebijakan konektor. Di web, metrik arus transaksi (taker buy/sell) ikut terhitung.
- **Headline berita tidak tersedia.** API gratis CoinGecko tidak menyediakan berita. Skor narasi tetap jalan tanpa komponen headline, dan statusnya tampil *DEGRADED* di System Health.
- **Klasifikasi narasi lebih lambat di kunjungan pertama.** API CoinGecko tanpa key dibatasi sekitar 10 panggilan per menit. Setiap kali aplikasi dibuka, 60 coin diklasifikasi otomatis, dan sisanya bisa dijalankan dengan tombol *Classify remaining* di Narrative Intelligence. Hasilnya disimpan 7 hari. Dengan Demo key gratis prosesnya sekitar 3× lebih cepat.

## Penyimpanan data

Journal, watchlist, pengaturan risiko, paper trade, riwayat sinyal, dan snapshot scan disimpan di **IndexedDB browser Anda**.

- Ini **bukan database server**. Data hanya ada di browser dan perangkat itu, tidak tersinkron ke perangkat lain, dan **hilang** kalau data situs dibersihkan.
- Gunakan **⚙ Web → Unduh backup (.json)** secara rutin. File itu bisa dipulihkan lewat **Pulihkan backup**, termasuk di perangkat lain.
- Data di versi artifact claude.ai tidak ikut pindah. Kedua versi berdiri sendiri.

## Batasan

- Scan, refresh 15 detik, evaluasi ulang tiap candle M15, dan alarm momentum hanya berjalan **selama halaman terbuka**. Tidak ada server latar belakang dan tidak ada notifikasi ke ponsel.
- Batas Binance: sekitar 6.000 weight per menit per IP. Satu scan penuh memakai jauh di bawah itu.
- API key CoinGecko dan Etherscan disimpan di `localStorage` browser, dalam teks biasa. Pakai key khusus untuk aplikasi ini.

## Struktur file

| File | Isi |
|---|---|
| `index.html` | Aplikasi: tampilan dan logika halaman, sama dengan versi artifact |
| `engine.js` | Mesin perhitungan murni dan suite tes, yang bisa dijalankan dari System Health |
| `shim.js` | Pengganti runtime artifact: akses API publik, database IndexedDB, unduhan, dan panel ⚙ Web |
| `.nojekyll` | Mencegah GitHub Pages memproses situs dengan Jekyll |
