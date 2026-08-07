import { useEffect, useRef, useState } from "react";
import { useStore } from "../app/store";
import { cameraDeck } from "../lib/deck";
import { useCameras, type CameraDevice } from "../lib/cameras";
import { Icon } from "./ui/Icon";
import { Empty } from "./ui/controls";

/**
 * The cameras attached to this machine.
 *
 * A tab of its own rather than a corner of the video library: a camera is not
 * a file somebody imported, it is a thing plugged into the desk that may or may
 * not be there this morning. The list is whatever the operating system reports
 * right now, and it re-reads itself when something is plugged in or unplugged.
 *
 * Each tile shows the real picture, so the shot can be checked before the room
 * sees it — the whole reason a confidence view exists.
 */
export function CameraTab() {
  const t = useStore((s) => s.t);
  const live = useStore((s) => s.live);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const blank = useStore((s) => s.toggleBlank);
  const cameras = useCameras();

  /** Sends a camera to the screens. One slide, like a clip. */
  const show = async (camera: CameraDevice) => {
    await loadDeck(cameraDeck(camera.id, camera.name));
    await go(0);
  };

  const isLive = (camera: CameraDevice) =>
    live.kind === "camera" && (live.cameraDeviceId ?? "") === camera.id;
  const anyLive = live.kind === "camera";

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__head">
          <span className="panel__title">{t("tab.camera")}</span>
          <div className="topbar__spacer" />
          <span className="field__hint">{t("camera.localOnly")}</span>
          <button className="btn btn--sm" onClick={() => void blank()} disabled={!anyLive}>
            <Icon name="eyeOff" size={12} />
            {t("transport.blankBtn")}
          </button>
        </div>

        <div className="panel__body">
          {cameras.length === 0 ? (
            <Empty title={t("camera.none")} hint={t("camera.noneHint")} />
          ) : (
            <div className="tiles tiles--video">
              {cameras.map((camera) => {
                const on = isLive(camera);
                return (
                  <div
                    key={camera.id}
                    className="tile tile--video"
                    data-live={on || undefined}
                    title={t("camera.showHint")}
                    onDoubleClick={() => void show(camera)}
                  >
                    <div className="tile__media">
                      <CameraPreview deviceId={camera.id} />
                    </div>
                    <div className="tile__foot">
                      <span className="track__name" title={camera.name}>
                        {camera.name}
                      </span>
                      <button
                        className={
                          on ? "btn btn--sm btn--icon btn--primary" : "btn btn--sm btn--icon"
                        }
                        title={on ? t("media.stop") : t("menu.show")}
                        onClick={() => (on ? void blank() : void show(camera))}
                      >
                        <Icon name={on ? "eyeOff" : "eye"} size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * One camera, shown in the console so the operator sees it before the room.
 *
 * Its own stream rather than the projection window's: this is a second view of
 * the same device, which every platform allows. What matters is that it is
 * released the moment the tab is left — a camera held open keeps its light on
 * and locks the device against everything else on the machine, which on a
 * Sunday morning is somebody else's stream that will not start.
 */
function CameraPreview({ deviceId }: { deviceId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    void (async () => {
      try {
        // `ideal`, not `exact`: a camera unplugged since it was last chosen
        // should fall back to whatever is there rather than fail outright.
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { ideal: deviceId } } : true,
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setFailed(null);
        if (ref.current) {
          ref.current.srcObject = stream;
          await ref.current.play().catch(() => {});
        }
      } catch (error) {
        // Denied, already in use, or gone. Named rather than left as a black
        // rectangle nobody can account for.
        if (!cancelled) setFailed(error instanceof Error ? error.name : "error");
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (ref.current) ref.current.srcObject = null;
    };
  }, [deviceId]);

  if (failed) {
    return (
      <div className="empty" style={{ padding: 14 }}>
        <div className="empty__title">{failed}</div>
      </div>
    );
  }

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      // A camera never carries sound here: the room has the real thing, and an
      // open microphone beside a PA system is feedback.
      muted
      style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }}
    />
  );
}
