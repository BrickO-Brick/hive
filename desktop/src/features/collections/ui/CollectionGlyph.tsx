import { Folder } from "lucide-react";

import type { Collection } from "../types";

export function CollectionGlyph({
  collection,
  className,
}: {
  collection: Pick<Collection, "icon">;
  className?: string;
}) {
  return collection.icon ? (
    <span aria-hidden="true" className={className}>
      {collection.icon}
    </span>
  ) : (
    <Folder aria-hidden="true" className={className} />
  );
}
