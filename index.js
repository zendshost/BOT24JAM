const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();
const { URLSearchParams } = require('url');

const PI_API_SERVER = 'https://mainnet.zendshost.id';
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(PI_API_SERVER);

// Fungsi delay (jeda)
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Kirim notifikasi ke Telegram
async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error("Telegram error:", e.message);
    }
}

// Baca file pharse.txt
function loadMnemonics() {
    try {
        const data = fs.readFileSync('pharse.txt', 'utf8');
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== '');
        if (!lines.length) throw new Error("File pharse.txt kosong!");
        return lines;
    } catch (e) {
        console.error("❌ Gagal baca file pharse.txt:", e.message);
        process.exit(1);
    }
}

// Mendapatkan keypair dari mnemonic
async function getWalletFromMnemonic(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error("Mnemonic tidak valid.");
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

// Kirim transaksi ke jaringan Pi
async function submitTransaction(xdr) {
    try {
        const response = await axios.post(`${PI_API_SERVER}/transactions`, new URLSearchParams({ tx: xdr }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 100000
        });
        if (response.data.status === 'ERROR') throw new Error(response.data.detail);
        return response.data;
    } catch (e) {
        throw new Error("Gagal submit transaksi: " + (e.response?.data?.detail || e.message));
    }
}

// Fungsi kirim Pi ke alamat muxed
async function sendPi(mnemonic, recipientMuxedAddress, walletIndex) {
    let wallet;
    try {
        wallet = await getWalletFromMnemonic(mnemonic);
        const sender = wallet.publicKey;
        const memoText = process.env.MEMO || "BotPi888";
        console.log(`\n🔑 Wallet #${walletIndex + 1}: ${sender}`);

        const account = await server.loadAccount(sender);
        const nativeBalance = account.balances.find(b => b.asset_type === 'native');
        if (!nativeBalance) throw new Error("Wallet tidak memiliki saldo Pi.");

        const balance = parseFloat(nativeBalance.balance);
        const baseFee = await server.fetchBaseFee(); // in stroops
        const feeInPi = baseFee / 1e7;

        const rawAmount = balance - 1 - feeInPi;

        console.log(`💰 Balance: ${balance}, Fee: ${feeInPi}, Transferable: ${rawAmount}`);

        if (!Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount < 0.0000001) {
            throw new Error("Saldo tidak cukup atau jumlah terlalu kecil untuk dikirim.");
        }

        const formattedAmount = rawAmount.toFixed(7);

        const txBuilder = new StellarSdk.TransactionBuilder(account, {
            fee: baseFee.toString(),
            networkPassphrase: PI_NETWORK_PASSPHRASE,
            allowMuxedAccounts: true
        })
            .addMemo(StellarSdk.Memo.text(memoText))
            .addOperation(StellarSdk.Operation.payment({
                destination: recipientMuxedAddress,
                asset: StellarSdk.Asset.native(),
                amount: formattedAmount
            }))
            .setTimeout(30);

        const tx = txBuilder.build();
        tx.sign(StellarSdk.Keypair.fromSecret(wallet.secretKey));
        const res = await submitTransaction(tx.toXDR());

        const notif = `✅ <b>Transaksi ke OKX Berhasil!</b>\n\n` +
            `🆔 <b>TX Hash:</b> <code>${res.hash}</code>\n` +
            `👤 <b>Dari:</b> <code>${sender}</code>\n` +
            `🏦 <b>Ke (OKX Muxed):</b> <code>${recipientMuxedAddress}</code>\n` +
            `📝 <b>Memo:</b> <code>${memoText}</code>\n` +
            `💰 <b>Jumlah:</b> <code>${formattedAmount} π</code>\n` +
            `📅 <b>Waktu:</b> ${new Date().toISOString()}\n` +
            `🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${res.hash}">Detail Transaksi</a>`;

        console.log(notif.replace(/<[^>]*>?/gm, ''));
        await sendTelegramNotification(notif);

    } catch (e) {
        const addr = wallet?.publicKey || `Wallet #${walletIndex + 1}`;
        console.error(`❌ Gagal Transfer ${addr}:`, e.message);

        if (e.message.toLowerCase().includes("destination is invalid")) {
            console.error("-> PETUNJUK: Pastikan RECEIVER_ADDRESS di file .env adalah alamat Muxed yang valid (dimulai dengan 'M').");
        }

        if (!e.message.includes("Saldo tidak cukup")) {
            await sendTelegramNotification(`❌ <b>Gagal Transfer</b> dari <code>${addr}</code>\nAlasan: ${e.message}`);
        }
    }
}

// Fungsi utama
(async () => {
    console.log("🚀 Memulai bot transfer Pi ke OKX (Mode Alamat Muxed)...");

    const mnemonics = loadMnemonics();
    const recipient = process.env.RECEIVER_ADDRESS;

    if (!recipient || !recipient.startsWith('M')) {
        console.error("❌ KESALAHAN FATAL: `RECEIVER_ADDRESS` di file .env tidak valid!");
        console.error("   Harus berupa alamat Muxed dari OKX (yang dimulai dengan huruf 'M').");
        process.exit(1);
    }

    console.log(`🏦 Alamat Tujuan (OKX Muxed): ${recipient}`);
    console.log(`💼 Ditemukan ${mnemonics.length} wallet di pharse.txt. Memulai siklus...`);

    let index = 0;
    while (true) {
        await sendPi(mnemonics[index], recipient, index);
        await sleep(10); // ⏳ jeda antar wallet: 10 ms

        index = (index + 1) % mnemonics.length;

        if (index === 0) {
            console.log(`\n🔁 Siklus transfer semua wallet selesai. Menunggu 1 ms sebelum memulai ulang...`);
            await sleep(1);
        }
    }
})();
