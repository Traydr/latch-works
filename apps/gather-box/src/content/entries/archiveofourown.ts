import { collectArchiveOfOurOwnData } from "../collectors/archiveofourown";
import { installCollector } from "../collector-entry";

installCollector("archiveofourown", collectArchiveOfOurOwnData);
