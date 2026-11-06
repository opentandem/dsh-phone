// Prints one QR code as SVG. Runs in its own process; see qrSvg in index.js.
require('qrcode').toString(process.argv[2], { type: 'svg', margin: 1, width: 240 }).then(svg => process.stdout.write(svg), () => process.exit(1))
