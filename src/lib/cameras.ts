import { useEffect, useState } from "react";

export interface CameraDevice {
  /** The browser's device id. Stable per machine once permission is given. */
  id: string;
  name: string;
}

/**
 * Cameras attached to this machine.
 *
 * Two things about `enumerateDevices` shape this. It lists devices before
 * permission is granted but withholds their *labels*, so an operator who has
 * never said yes sees "Camera 1", "Camera 2" — enough to pick one, after which
 * the real names appear. And the list changes when a camera is plugged in or
 * unplugged mid-service, so it is re-read on `devicechange` rather than once
 * at startup.
 */
export function useCameras(): CameraDevice[] {
  const [cameras, setCameras] = useState<CameraDevice[]>([]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;

    let cancelled = false;
    const read = () => {
      void media
        .enumerateDevices()
        .then((devices) => {
          if (cancelled) return;
          const found = devices
            .filter((device) => device.kind === "videoinput")
            .map((device, index) => ({
              id: device.deviceId,
              name: device.label.trim() || `Camera ${index + 1}`,
            }));
          setCameras(found);
        })
        .catch(() => {
          // A machine with no camera, or a browser refusing to enumerate, is
          // simply a machine with no cameras to offer.
          if (!cancelled) setCameras([]);
        });
    };

    read();
    media.addEventListener?.("devicechange", read);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", read);
    };
  }, []);

  return cameras;
}
