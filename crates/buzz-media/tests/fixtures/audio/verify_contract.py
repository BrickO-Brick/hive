import struct,sys
def crc32_ogg(data):
    crc=0
    for b in data:
        crc^=b<<24
        for _ in range(8):
            crc=((crc<<1)^0x04c11db7)&0xFFFFFFFF if crc&0x80000000 else (crc<<1)&0xFFFFFFFF
    return crc
def check(path):
    d=open(path,'rb').read(); off=0; i=0; errs=[]; serials=set()
    while off<len(d) and d[off:off+4]==b'OggS':
        nseg=d[off+26];seg=d[off+27:off+27+nseg];hdr=27+nseg;body=hdr+sum(seg)
        page=d[off:off+body];pay=d[off+hdr:off+body]
        seq=struct.unpack('<I',page[18:22])[0]
        stored=struct.unpack('<I',page[22:26])[0]
        granule=struct.unpack('<Q',page[6:14])[0]
        calc=crc32_ogg(page[:22]+b'\x00'*4+page[26:])
        serials.add(page[14:18])
        if stored!=calc: errs.append(f"page{i}: CRC mismatch")
        if seq!=i: errs.append(f"page{i}: seq={seq} not contiguous")
        # RFC 3533 6.2: granule -1 (0xFF..FF) means "no packet completes on this
        # page". The three Vorbis header packets carry no sample position, so a
        # header page that DOES complete a packet has granule 0 — never the -1
        # sentinel. (A header page that completes nothing, i.e. a spanning setup
        # continuation, legitimately carries -1.) Leaking -1 onto a completing
        # header page decodes fine everywhere, so only a structural check sees
        # it; the relay validator rejects it.
        completes = len(seg)>0 and seg[-1]!=255
        if i<3 and completes and granule!=0:
            shown="-1 (0xFF..FF sentinel)" if granule==0xFFFFFFFFFFFFFFFF else granule
            errs.append(f"page{i}: header-page granule={shown}, want 0")
        if i==0:
            if not (page[5]&0x02): errs.append("page0: BOS flag not set")
            if pay[:7]!=b'\x01vorbis': errs.append("page0: not identification")
            if len(seg)!=1: errs.append(f"page0: {len(seg)} packets, want ident alone")
        if i==1:
            if pay[:7]!=b'\x03vorbis': errs.append("page1: not comment")
            if len(seg)!=1: errs.append(f"page1: {len(seg)} lacing values, contract wants ONE")
            if pay!=b'\x03vorbis'+struct.pack('<I',0)+struct.pack('<I',0)+b'\x01':
                errs.append("page1: comment not canonical-empty")
        if i==2:
            if pay[:7]!=b'\x05vorbis': errs.append("page2: setup not isolated at page2")
        off+=body;i+=1
    if len(serials)!=1: errs.append(f"{len(serials)} logical streams, want 1")
    print(f"{path}: pages={i} serials={len(serials)}")
    for e in errs: print("   VIOLATION:",e)
    if not errs: print("   conforms to locked contract")
for p in sys.argv[1:]: check(p)
