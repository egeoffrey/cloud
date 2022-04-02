rm -rf sdk lib img gui favicon.ico index.html
git clone https://github.com/egeoffrey/egeoffrey-gui
git clone https://github.com/egeoffrey/egeoffrey-sdk
mv egeoffrey-sdk/sdk/ .
mv egeoffrey-gui/gui/html/* .
rm -rf egeoffrey-gui/
rm -rf egeoffrey-sdk/
