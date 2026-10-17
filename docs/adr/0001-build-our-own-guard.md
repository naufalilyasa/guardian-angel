# Bangun guard sendiri, bukan adopsi cc-safety-net

cc-safety-net sudah terpasang di mesin ini dan punya adapter pi yang block-only: tanpa undo, tanpa tier ask native, dan tanpa analisis input MCP. Kita membangun guardian-angel sendiri karena tiga diferensiasi yang kita incar (Trash/Undo, ask lewat ctx.ui.confirm, analisis SQL di dalam MCP call) tidak ada di sana dan arah produknya dipegang pihak lain. Alternatif yang ditolak: adopsi penuh (kehilangan undo) dan kontribusi adapter ke cc-safety-net (batas platform).
