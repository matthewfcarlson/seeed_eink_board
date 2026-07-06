export const kvKeys = {
  device: (mac: string) => `device:${mac}`,
  rotation: (deviceKey: string) => `rotation:${deviceKey}`,
  schedule: (target: string) => `schedule:${target}`,
};
