import { collectPixivData } from "../collectors/pixiv";
import { installCollector } from "../collector-entry";

installCollector("pixiv", collectPixivData);
