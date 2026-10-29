const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`VERTO Web потребує Node.js 22.13 або новішого (зараз ${process.versions.node}).\nОновіть Node: https://nodejs.org/ або NodeSource (див. README).`);
  process.exit(1);
}
