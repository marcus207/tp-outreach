#!/bin/bash
# Generate 12 hero image variations per sector from base images
# Uses ImageMagick to create crops, tints, contrast/brightness shifts

SRC_DIR="/root/tp_website_dev/frontend/public/images/sectors"
OUT_DIR="/root/tp-outreach/data/hero"
mkdir -p "$OUT_DIR"

# Map sectors to their base image
declare -A SECTOR_BASE=(
  [btr]="btr_manchester.jpg"
  [hospitality]="hospitality.jpg"
  [sfh]="living.jpg"
  [pbsa]="pbsa.jpg"
  [living]="living.jpg"
  [logistics]="logistics_uk.jpg"
  [office]="office_london_modern.jpg"
  [retail]="retail.jpg"
  [care]="healthcare_uk.jpg"
  [leisure]="hospitality.jpg"
)

# Also handle introducer sectors (use generic office/city images)
declare -A INTRO_BASE=(
  [accountant]="office.jpg"
  [advisory]="office_mayfair.jpg"
  [agent]="retail.jpg"
  [lawyer]="office_london_modern.jpg"
  [surveyor]="btr_manchester.jpg"
  [wealth]="office_mayfair.jpg"
  [construction]="construction_uk.jpg"
  [planning_architect]="btr_manchester.jpg"
)

generate_variations() {
  local sector="$1"
  local base="$2"
  local src_path="$SRC_DIR/$base"

  if [ ! -f "$src_path" ]; then
    echo "  WARN: $src_path not found, skipping $sector"
    return
  fi

  echo "=== $sector (from $base) ==="

  # Get dimensions
  local w h
  read w h < <(identify -format "%w %h" "$src_path" 2>/dev/null)

  for i in $(seq 1 12); do
    local outfile="$OUT_DIR/${sector}_$(printf '%02d' $i).jpg"
    if [ -f "$outfile" ] && [ $(stat -c%s "$outfile") -gt 5000 ]; then
      echo "  [$i/12] $outfile — exists, skipping"
      continue
    fi

    case $i in
      1)  # Original resized
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 -quality 78 -strip "$outfile"
        ;;
      2)  # Slight warm tint
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -modulate 100,110,95 -quality 78 -strip "$outfile"
        ;;
      3)  # Cool tint
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -modulate 100,90,110 -quality 78 -strip "$outfile"
        ;;
      4)  # Higher contrast
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -brightness-contrast 5x15 -quality 78 -strip "$outfile"
        ;;
      5)  # Top crop
        convert "$src_path" -resize 600x -gravity north -extent 600x400 -quality 78 -strip "$outfile"
        ;;
      6)  # Bottom crop
        convert "$src_path" -resize 600x -gravity south -extent 600x400 -quality 78 -strip "$outfile"
        ;;
      7)  # Slightly desaturated
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -modulate 100,70,100 -quality 78 -strip "$outfile"
        ;;
      8)  # Brightened
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -brightness-contrast 12x5 -quality 78 -strip "$outfile"
        ;;
      9)  # Darkened slightly
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -brightness-contrast -8x8 -quality 78 -strip "$outfile"
        ;;
      10) # Left crop
        convert "$src_path" -resize x400 -gravity west -extent 600x400 -quality 78 -strip "$outfile"
        ;;
      11) # Teal overlay tint (brand colour)
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          \( +clone -fill "#0D9488" -colorize 8% \) -compose Over -composite -quality 78 -strip "$outfile"
        ;;
      12) # Sepia-ish warm
        convert "$src_path" -resize 600x400^ -gravity center -extent 600x400 \
          -modulate 98,85,98 -brightness-contrast 3x8 -quality 78 -strip "$outfile"
        ;;
    esac

    local size_kb=$(( $(stat -c%s "$outfile") / 1024 ))
    echo "  [$i/12] ${sector}_$(printf '%02d' $i).jpg (${size_kb}KB)"
  done
}

# Client sectors
for sector in "${!SECTOR_BASE[@]}"; do
  generate_variations "$sector" "${SECTOR_BASE[$sector]}"
done

# Introducer sectors (mapped to directory-safe names)
generate_variations "accountant" "${INTRO_BASE[accountant]}"
generate_variations "advisory" "${INTRO_BASE[advisory]}"
generate_variations "agent" "${INTRO_BASE[agent]}"
generate_variations "lawyer" "${INTRO_BASE[lawyer]}"
generate_variations "surveyor" "${INTRO_BASE[surveyor]}"
generate_variations "wealth" "${INTRO_BASE[wealth]}"
generate_variations "construction" "${INTRO_BASE[construction]}"
generate_variations "planning_architect" "${INTRO_BASE[planning_architect]}"

echo ""
echo "=== DONE ==="
ls "$OUT_DIR" | wc -l
echo "images in $OUT_DIR"
