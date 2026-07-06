-- ============================================================================
-- Desync Remediation runbook — FlowType/Category corpus certification
-- Generated 2026-07-06 from scripts/.backfill-logs/ (701 ids, verified unique).
-- Plan: docs/initiatives/desync/DESYNC_REMEDIATION_2026-07-06.md
--
-- READ THE PLAN FIRST. Run against the LOCAL Postgres on the operator machine.
-- Phases 0/1/4 are read-only; Phase 2 is the ONLY write in this file.
-- Phase 3 (reclassify) is NOT sql — it is:
--     npx tsx scripts/backfill-flowtype.ts            # dry-run, expect 701
--     npx tsx scripts/backfill-flowtype.ts --apply    # writes flow columns only
-- ============================================================================

-- The 701-row remediation population (union of the three backfill logs).
-- Defined once as a temp view so every phase references the identical set.
CREATE TEMP VIEW desync_pop (id) AS VALUES
  'cmr45f4va0098117fh3hbfphx', 'cmr45f56o00b8117fmazq5i9v', 'cmr45hz99032c117fz482f6bs', 'cmr45hz9i032e117fdg3v9oqs', 'cmr45i5e403he117f2std2x7n', 'cmr45i5hh03i0117fr1crdw7d',
  'cmr45i5lq03is117f5gapbdef', 'cmr45i5op03ji117fmj22yct5', 'cmr45i5zd03le117fy1i31lwq', 'cmr45i62x03ly117fqblqcuas', 'cmr45i72203mk117fvz5dt7ag', 'cmr45i72f03mw117fst5h65v6',
  'cmr45i7bx03pc117fbcr3k6fx', 'cmr45i7c603pk117f8ppam1ee', 'cmr45i7cb03po117f2y8zeh66', 'cmr45i7d303q6117f1gst9h8l', 'cmr45i7dm03qk117f6vtv2b13', 'cmr45i7ej03r2117fanrvs87g',
  'cmr45i8jm03rw117f0kw6i3x3', 'cmr45i8n203sm117fgtaae157', 'cmr45i8o603ss117fnojgyb3s', 'cmr45i8qq03t6117fe2h8dphd', 'cmr45i8tn03tu117fm6gozeqy', 'cmr45i8v103u6117f2xirpzl0',
  'cmr45i8xm03uo117f3mq4wido', 'cmr45i91x03vi117fa2mrlo4m', 'cmr45i93803vq117fj8gst6ds', 'cmr45i96w03wc117fzt387jae', 'cmr45i97i03wg117fq78dfmig', 'cmr45i99x03ww117foctkikir',
  'cmr45im8204tm117f8v9jyo9t', 'cmr45iny404v8117fr7kho4zq', 'cmr45iod404yq117fqbdiv7ru', 'cmr45ir6u0534117fq1m3w0p2', 'cmr45irao0540117fomwdh79o', 'cmr45irb8054a117fm03id87r',
  'cmr45iyn505ae117fcrg7v380', 'cmr45iz5v05e8117f2h0z8t0n', 'cmr45iz7h05eq117fc9uwk5xl', 'cmr45iz8r05f4117fvpsd9rjw', 'cmr45jicv05g2117f4ejn13w5', 'cmr45jidz05ga117fu2kp4s7h',
  'cmr45jkea05pe117furgqouzv', 'cmr45jm2t05rw117fwcx5epd0', 'cmr45jnrr05zk117fttln0y9x', 'cmr45jnu6060a117fsl7lvq1r', 'cmr45jp4l0628117f2kpitkz3', 'cmr45jpdg064m117fzmgefa3e',
  'cmr45jph3065g117f177dfwxf', 'cmr45jqa1066o117fdbtys87z', 'cmr45jqer067o117f8xby9sjm', 'cmr459r06001n117fn2qg7ewl', 'cmr459r0e001p117fp6veflo4', 'cmr459r0k001r117fvoxsvjcq',
  'cmr459r0z001v117f0b13sie8', 'cmr459r16001x117fknneh7ld', 'cmr459r1d001z117f4e8i1tcr', 'cmr459r1k0021117fmihrdhe6', 'cmr459r1z0025117fh6ksn6fh', 'cmr459r250027117f6blytuoe',
  'cmr459r2d0029117fwj6lfnd4', 'cmr459r2k002b117ftx5i1pve', 'cmr459r2r002d117f605x75f0', 'cmr459r2z002f117f3g3cl5mp', 'cmr459r3l002l117flx8cd6y4', 'cmr459r3t002n117ffc1yna58',
  'cmr459r42002p117fmkzx4z1p', 'cmr459r4b002r117fgu6ec689', 'cmr459r4n002t117fo15nlnxl', 'cmr459r4z002v117f3epftsdv', 'cmr459r58002x117fir2toez4', 'cmr459r5h002z117fwifk9ij0',
  'cmr459r5v0031117fmj764d5p', 'cmr459r660033117fbw2sn5q6', 'cmr459r6g0035117f8e03tz7v', 'cmr459r6p0037117f8mfe0bim', 'cmr459r7a003b117ff62wu7rg', 'cmr459r7k003d117f8up9xe7l',
  'cmr459r7u003f117fzdzigk86', 'cmr459r86003h117fjql7syv9', 'cmr459r8s003l117f0dnyb4vc', 'cmr459r92003n117f4edw8h5f', 'cmr459r9g003p117f1nkzpvat', 'cmr459r9p003r117f14hzp1po',
  'cmr459rak003x117fzjzfw7pa', 'cmr459rau003z117fem6681kw', 'cmr459rb40041117f2oow5thp', 'cmr459rbf0043117fw0klc827', 'cmr45f4sb008i117f7rewxo0o', 'cmr45gzo200dw117fp0yl87tk',
  'cmr45gzq400ea117f3n381bdi', 'cmr45gzs100eo117f87e9wwe0', 'cmr45h0ai00i0117f4kmqtxco', 'cmr45h0ar00i2117fwj0zk5ai', 'cmr45h0fl00is117fra0z51p8', 'cmr45h0hk00j0117f7vamrojt',
  'cmr45h20b00l6117ff1qmjo8v', 'cmr45h21f00lc117fb6enoahu', 'cmr45h22o00lk117ficzeqz17', 'cmr45h3ha00pe117f5s0p1mjv', 'cmr45h4tm00uk117fy15354un', 'cmr45h4ty00um117fdklimcof',
  'cmr45h4u500uo117fm7z4hht1', 'cmr45h4uj00uq117fnstbxqtb', 'cmr45h4uv00us117fqhmn5md5', 'cmr45h4vf00uw117fqi8gce7b', 'cmr45h4vq00uy117f8d1t7pso', 'cmr45h4w100v0117ftd8mntgv',
  'cmr45h4wb00v2117fp07a557t', 'cmr45h4x600v8117fzmbots37', 'cmr45h4xe00va117fjbmbza7y', 'cmr45h4xu00vc117f0ch70net', 'cmr45h4y300ve117fjhzryz0w', 'cmr45h4yc00vg117f6jeyf6g9',
  'cmr45h4ym00vi117f5fy8wa53', 'cmr45h4yx00vk117ft8ch5vn4', 'cmr45h4z900vm117fp66l085w', 'cmr45h50d00vu117f9sfdfoh5', 'cmr45h50l00vw117f1zkjwhuv', 'cmr45h50v00vy117f260c1iwr',
  'cmr45h51500w0117fpurgph8m', 'cmr45h51f00w2117fk4xdwi6x', 'cmr45h51p00w4117fmv9mp5sc', 'cmr45h51x00w6117fuqids3db', 'cmr45h52300w8117fga8s5r2l', 'cmr45h52b00wa117f8k1ubrp5',
  'cmr45h52i00wc117foo82i6jx', 'cmr45h52r00we117fedzd1hmi', 'cmr45h52z00wg117f9d31lgrl', 'cmr45h53a00wi117fiuud6ni0', 'cmr45h53m00wk117fd9s639lo', 'cmr45h53w00wm117fy6wew9p5',
  'cmr45h54j00wq117fr484ddqz', 'cmr45h54s00ws117f0i01objh', 'cmr45h55m00wy117fs5suaqpc', 'cmr45h55y00x0117f15d24tmg', 'cmr45h56800x2117fk1ia4s3a', 'cmr45h56h00x4117fiqd3lww2',
  'cmr45h57400x8117frdim9ndt', 'cmr45h57g00xa117f8c6rh61t', 'cmr45h57r00xc117fhmpc2fgq', 'cmr45h58600xg117fn35k0nhx', 'cmr45h58p00xi117f3uewxab2', 'cmr45h58z00xk117fzs2uciki',
  'cmr45h59900xm117f5swiqkzn', 'cmr45h59l00xo117fkac16v4n', 'cmr45h5af00xs117f93bmu9ro', 'cmr45h5aq00xu117frj3jvqnw', 'cmr45h5b100xw117fgh6dzj5l', 'cmr45h5b800xy117fa2i2j8tx',
  'cmr45h5bi00y0117fc5bybgtw', 'cmr45h5ca00y6117fiuow7s6h', 'cmr45h5cz00ya117flno89h5k', 'cmr45h5dz00yg117fdqmo1v7e', 'cmr45h5ef00yi117f6aj3oe6m', 'cmr45h5ev00yk117f0xwzys1k',
  'cmr45h5fh00ym117fq44mjult', 'cmr45h5ft00yo117fglf6fukd', 'cmr45h5g900yq117f3b05n7v3', 'cmr45h5gl00ys117flg30ptnp', 'cmr45h5gw00yu117fbzckbr31', 'cmr45h5h700yw117fezy80wbk',
  'cmr45h5if00z2117f0tclcdtp', 'cmr45h5io00z4117fdcppxwue', 'cmr45h5iz00z6117famjeb623', 'cmr45h5j900z8117fj6xpqp6v', 'cmr45h5jj00za117fsvz73zxb', 'cmr45h5k100ze117ftmoszwze',
  'cmr45h5ka00zg117fj9awip30', 'cmr45h5ki00zi117f2uacirnh', 'cmr45h5ku00zk117f9p083718', 'cmr45h5l200zm117ftvv8tlig', 'cmr45h5lg00zo117frjj2dake', 'cmr45h5lq00zq117fivcichr2',
  'cmr45h6u400zs117fm0orzcmc', 'cmr45h6w20100117fgqieasz6', 'cmr45h6we0102117fucz7jdx7', 'cmr45h6wp0104117f3pug53hh', 'cmr45h6xu010c117fp0qkhoma', 'cmr45h6y9010g117fk8ldy0rm',
  'cmr45h6yg010i117f3ee1otuj', 'cmr45h6yr010k117fsiqw00di', 'cmr45h6zq010s117f2w11ghv8', 'cmr45h6zz010u117fd12dzyf6', 'cmr45h70e010y117f9vlkrscc', 'cmr45h70n0110117f8dnq8rk4',
  'cmr45h7180116117fv0jcq5z4', 'cmr45h71h0118117famymty5o', 'cmr45h729011c117f3rz6cnkc', 'cmr45h72j011e117fmtbld2m0', 'cmr45h73r011o117f3ej3k9pa', 'cmr45h744011s117fgg5gnibe',
  'cmr45h74d011u117ff2o32daa', 'cmr45h74k011w117fi80zo46t', 'cmr45h783012g117fi1qtaxtg', 'cmr45h78f012i117feglcemqi', 'cmr45h78r012k117ft8w8nq2h', 'cmr45h79s012q117fqn6z7wgr',
  'cmr45h7ae012s117fbhclon42', 'cmr45h7ar012u117ff38an2hg', 'cmr45h7cg0132117fv6uosy4y', 'cmr45h7fy013i117f6wrqfvgn', 'cmr45h7h2013o117f8qerz13g', 'cmr45h7i6013u117ff1z52vtl',
  'cmr45h7iq013w117fvgt80lo8', 'cmr45h7j5013y117fdax1xwhu', 'cmr45h7lj0148117f008fzh0s', 'cmr45h7lv014a117fc9pdr9x1', 'cmr45h7mh014e117fysj2ys9m', 'cmr45h7mt014g117f9fxwjp54',
  'cmr45h8ym019a117f5ltncl97', 'cmr45h8zg019i117f08g3jwio', 'cmr45h908019o117f3e5uvy1y', 'cmr45h90z019u117fjon4e386', 'cmr45h919019w117fnahy5209', 'cmr45h91g019y117f5de1vnc7',
  'cmr45h91r01a0117fx3e1f8sm', 'cmr45h92a01a4117fv79mx931', 'cmr45h92m01a6117fycd6lf6b', 'cmr45h92y01a8117fwp9q7bdf', 'cmr45h93801aa117fkuv0btde', 'cmr45h9qo01ae117fqw8skrb1',
  'cmr45h9qy01ag117fszuxxdoq', 'cmr45h9rc01ai117fqgyg9vwm', 'cmr45h9ro01ak117fe3znl8r7', 'cmr45h9s101am117fehmafjdd', 'cmr45h9sb01ao117fu12mpm8p', 'cmr45h9sn01aq117f9lyix94m',
  'cmr45h9t101as117f2av8paad', 'cmr45h9tb01au117fi3hxprwf', 'cmr45h9tz01ay117fux18wyqr', 'cmr45h9u901b0117ftpm1pfjf', 'cmr45h9up01b2117fjf89wsz8', 'cmr45h9vm01b8117fu5ydi7vj',
  'cmr45h9vz01bc117fthz60l6l', 'cmr45h9w701be117fxtpa0je5', 'cmr45h9wh01bi117f3qp1ntv0', 'cmr45h9wl01bk117f8pmzz308', 'cmr45h9wu01bm117fcd3w32ee', 'cmr45h9wz01bo117f2hcifuui',
  'cmr45h9x501bq117f1y8se99u', 'cmr45h9xa01bs117fanxlmkhg', 'cmr45h9xf01bu117f5a6tw9cm', 'cmr45h9xp01bw117fngvhcyn3', 'cmr45h9xz01c0117fo10qo22f', 'cmr45h9y701c2117ftnqxzpcq',
  'cmr45h9yd01c4117f0x7xwxgb', 'cmr45h9yk01c6117f76raw5l3', 'cmr45h9z301cc117f3yetnatl', 'cmr45h9za01ce117fjd1nudrb', 'cmr45h9zi01cg117fkhxx88ec', 'cmr45h9zo01ci117figluijm1',
  'cmr45h9zu01ck117fiuyvsmju', 'cmr45ha0y01cs117f1q1fdwt8', 'cmr45ha1401cu117fdg1wfuud', 'cmr45ha1h01cy117f4sowvpi3', 'cmr45ha1n01d0117fakzvu0fo', 'cmr45ha2g01d8117fnovsk4r7',
  'cmr45ha3e01di117f48t30n13', 'cmr45ha3u01dk117fbjwgwo47', 'cmr45ha5701dw117fbaok1vr1', 'cmr45ha6k01e6117f0hfdzanw', 'cmr45ha6x01e8117fxfktzco1', 'cmr45ha7y01ee117feqi83v0d',
  'cmr45ha8a01eg117fbm8ycxx4', 'cmr45ha8k01ei117fotya2pim', 'cmr45ha8u01ek117fp09zhhf4', 'cmr45ha9301em117fr6m6uu0w', 'cmr45ha9o01eq117f3r8v10tc', 'cmr45haar01ey117fw9l8nqwf',
  'cmr45habz01f6117fm045tvkm', 'cmr45hac701f8117f7b4fkmlb', 'cmr45had501fg117fyafs1ya0', 'cmr45hadg01fi117f7u8klvk1', 'cmr45haef01fo117f6ep98lzc', 'cmr45haeo01fq117faql3rcmr',
  'cmr45haf101fs117f5pahimes', 'cmr45hbe501g6117f9r1kboid', 'cmr45hbeg01g8117f6bji2u7i', 'cmr45hbfg01gg117f1uds8li4', 'cmr45hbfo01gi117f2bi8z7jp', 'cmr45hbgk01gq117f3cay9c82',
  'cmr45hbgv01gs117fgrywpq5m', 'cmr45hbho01gy117fddjauxht', 'cmr45hbi801h0117fv2271jdx', 'cmr45hbit01h4117fwoo7eszy', 'cmr45hbkx01hi117fhyy79hp5', 'cmr45hblj01hm117fjweu39h3',
  'cmr45hbn201hu117fr5d3s714', 'cmr45hbnf01hw117fmc56d7mk', 'cmr45hbns01hy117fzfzhfmp0', 'cmr45hbo101i0117f9qcpt17u', 'cmr45hbos01i6117fh4xkqncf', 'cmr45hboy01i8117f8jywq3xe',
  'cmr45hbpx01ig117f79gl7diu', 'cmr45hbqg01ik117ff5ccp7hn', 'cmr45hbqo01im117fh7hl3cm4', 'cmr45hbrv01iu117f4m4sz7ln', 'cmr45hbsd01iw117fj76saded', 'cmr45hbsy01j0117fj93jpd1s',
  'cmr45hbup01jc117fx3p57mwq', 'cmr45hbvt01ji117fae2zh8ig', 'cmr45hbzb01k8117fzg67yc0m', 'cmr45hbzl01ka117fej2p7f1v', 'cmr45hc0r01ki117fe8hhyi4l', 'cmr45hc0z01kk117f5df1klm2',
  'cmr45hc1h01ko117ff6l0cr0j', 'cmr45hc1p01kq117f0nvli1yl', 'cmr45hc2u01ky117fg3lczorg', 'cmr45hc3401l0117fvkf5tdzq', 'cmr45hc4h01la117fsvxno51h', 'cmr45hc4t01lc117fk6vmqfhe',
  'cmr45hdu901li117feht6bzay', 'cmr45hduw01lk117ftueiu60f', 'cmr45hdwe01lw117f8thn1fq7', 'cmr45hdx201m2117flhbsrcch', 'cmr45hdxc01m4117f1e4t6xc4', 'cmr45hdzj01mi117f3nqy19rc',
  'cmr45he0z01ms117ff3ix3vfs', 'cmr45he1701mu117fbtpqp2zc', 'cmr45he1p01my117fhhj8clah', 'cmr45he1y01n0117fiiisrubg', 'cmr45he2w01n8117fqpia2xbf', 'cmr45he3301na117f6fxalcw9',
  'cmr45he4y01nm117fv32mhdc7', 'cmr45he6001nu117fjn3uilal', 'cmr45he7i01o6117fdxwzql6s', 'cmr45he7p01o8117fnit3m7ew', 'cmr45he8c01oe117fbroql4ir', 'cmr45he8z01ok117f8y9mux5x',
  'cmr45he9701om117f7u64okuj', 'cmr45heaf01oy117furkxgj5f', 'cmr45hebv01pa117f151h8aoj', 'cmr45hecz01pi117fwy5b7h4k', 'cmr45hedk01pm117fg5d9xsmg', 'cmr45hedx01po117fzgoxy59m',
  'cmr45hefd01pw117f0r9rr5ia', 'cmr45hej601qk117fsbejlfpb', 'cmr45hejh01qm117f0y8jpfkw', 'cmr45hekx01qw117fmac2gger', 'cmr45hel901qy117fz9k0r3lb', 'cmr45hg6001r0117f63elqmm0',
  'cmr45hg8t01ri117ffww88eon', 'cmr45hgcy01sa117fnvg0rgng', 'cmr45hgei01sm117flczk7sgr', 'cmr45hges01so117f3mt4pfhf', 'cmr45hgg101sy117frkl8fr9c', 'cmr45hglu01u2117f3djoxxxt',
  'cmr45hgn101ug117fmhrysbq7', 'cmr45hgn601ui117fhwnjgy90', 'cmr45hgnd01uk117fpobbsi05', 'cmr45hgs901vs117f7hw8dx0t', 'cmr45hgtk01w6117f31crnbek', 'cmr45hi2l01w8117f19gj2rs8',
  'cmr45hi3q01wc117fo0t6mfey', 'cmr45hi4g01wg117fwf6r0728', 'cmr45hi4s01wi117fbq3dvyak', 'cmr45hi5401wk117fsqpgsz8n', 'cmr45hi5d01wm117flwppbs65', 'cmr45hi5l01wo117f5xsu3dk1',
  'cmr45hi5u01wq117fw0b9hp2l', 'cmr45hi6401ws117fvxkq9wcy', 'cmr45hi6y01wy117fnobqfhko', 'cmr45hi8101x6117fcdc4o1m1', 'cmr45hi8b01x8117faxs1f1qu', 'cmr45hi9j01xe117fd8m5qqah',
  'cmr45hia701xg117fjpn2iy9j', 'cmr45hib701xo117fhfvw2jpa', 'cmr45hibf01xq117fqqccy0y5', 'cmr45hid401y0117fo0kv12dy', 'cmr45hidg01y2117fp3w9opv3', 'cmr45hidq01y4117fwfbxkwe4',
  'cmr45hieb01y8117fcrl6g0ei', 'cmr45hiel01ya117fg1e50k1r', 'cmr45hiex01yc117f8o11vxmu', 'cmr45hiff01yg117f741asuto', 'cmr45hifr01yi117f0zwpkxuv', 'cmr45hihp01yu117fow9upkxk',
  'cmr45hihy01yw117f23ilp0gj', 'cmr45hikw01zk117f9lxigu5l', 'cmr45hil501zm117fm4uezewz', 'cmr45hilf01zo117f93cj6qo9', 'cmr45hinb01zy117f4d87a2g5', 'cmr45hinm0200117fg7kf0d4k',
  'cmr45hiob0204117fxsecofcj', 'cmr45hion0206117fim6291i6', 'cmr45hioz0208117fsmkiy10c', 'cmr45hipa020a117fzs8kycn1', 'cmr45hipn020c117fhclvc0v9', 'cmr45hiqo020e117fdd6wqmf2',
  'cmr45hiqw020g117friuf6fxt', 'cmr45hirg020k117fgqcp5xec', 'cmr45hisq020s117f7c2xe8wv', 'cmr45hitd020w117fwruuhgbe', 'cmr45hitq020y117frjtmcmk3', 'cmr45hiun0214117fdlqvh4f8',
  'cmr45hiv10216117f7r81zfkz', 'cmr45hivv021a117fw41ohjon', 'cmr45hiw6021c117f1a0jeya4', 'cmr45hk6s021g117flemxhk28', 'cmr45hk76021i117f7y4dvbi8', 'cmr45hk7g021k117fis94gg7j',
  'cmr45hk7r021m117fox7lvggg', 'cmr45hk8b021q117fo5shb38b', 'cmr45hk9i021y117fzlu044wu', 'cmr45hk9s0220117f8989h2yx', 'cmr45hka20222117f3ykflop5', 'cmr45hkad0224117ftfsy98jm',
  'cmr45hkb5022a117f95ja3luo', 'cmr45hkbg022c117fkr6h5pah', 'cmr45hkbq022e117fecas6tf0', 'cmr45hkc0022g117f2wbs4gcn', 'cmr45hkdq022s117fdr6h14um', 'cmr45hkeq022u117f0f6w23rn',
  'cmr45hkgl0236117f5nk5wutd', 'cmr45hkgu0238117fbeo75mg6', 'cmr45hkha023c117fgqutcpz4', 'cmr45hkhh023e117ffaq8zz4n', 'cmr45hkii023m117fs8apzoa9', 'cmr45hkiu023o117fpop9m0ea',
  'cmr45hkj6023q117ft94m5u0n', 'cmr45hkjf023s117f12d3cupk', 'cmr45hkkd023y117f2aj1gsjj', 'cmr45hkli0244117fs7bb7fz8', 'cmr45hkls0246117f8radcl8p', 'cmr45hkm20248117f0ywy6pi1',
  'cmr45hkn4024g117fro0y3wge', 'cmr45hkox024s117fo613yhoh', 'cmr45hkuw025w117fzy3rixod', 'cmr45hkv5025y117fhtdrrm9p', 'cmr45hkve0260117femkpmn8x', 'cmr45hkvp0262117f3219l0nx',
  'cmr45hkvy0264117frhvt60jw', 'cmr45hkwf0268117frx3vn0y0', 'cmr45hm2d0278117f9q58mq7u', 'cmr45hm2n027a117ffp4aufdx', 'cmr45hm2x027c117f6ndldo4a', 'cmr45hmby028y117f2i4kw3k8',
  'cmr45hmcu0294117fzcrntskt', 'cmr45hmd10296117f6grebcik', 'cmr45hmd80298117fyfyfmpa7', 'cmr45hme1029e117f9afk5x4z', 'cmr45hmfn029q117fgyr19kf1', 'cmr45hmg8029u117fjtiwzp7o',
  'cmr45ho1602du117fmcmyu792', 'cmr45hq4r02jk117fjg88wny6', 'cmr45hqg202lw117fuy79a7g2', 'cmr45hqmd02my117fb2yudmu3', 'cmr45htsh02ua117feph1v8dl', 'cmr45hty002v6117fwjgw4df4',
  'cmr45htzp02vg117f455lmmxj', 'cmr45hzd3033g117fdfb89gom', 'cmr45hzhz036w117f3pm0ar9q', 'cmr45i5d903h8117f1rmj9sp3', 'cmr45i5dl03ha117flx86norn', 'cmr45i5eo03hi117fnooi9d0j',
  'cmr45i5ez03hk117fzpupqplp', 'cmr45i5gw03hw117fv2h46bvt', 'cmr45i5kb03ii117fkbtzuejm', 'cmr45i5mc03iw117f56x0cta6', 'cmr45i5oa03je117f7e9wyk93', 'cmr45i5oh03jg117fd0peg1kk',
  'cmr45i5y403l6117f4kgxfx27', 'cmr45i5yg03l8117flboaapho', 'cmr45i5zm03lg117fsw1lrt8y', 'cmr45i60503li117fhu2hjsq4', 'cmr45i61703lk117feyd8yf1x', 'cmr45i62203ls117fx143n8k6',
  'cmr45i62m03lw117f5avi597y', 'cmr45i63e03m0117fci6gsmac', 'cmr45i63r03m2117fa3e5onve', 'cmr45i64203m4117f9ybrngca', 'cmr45i64h03m6117fvof9edaf', 'cmr45i64v03m8117fllducx9o',
  'cmr45i71h03ma117f2x7zmax0', 'cmr45i71r03me117f44hvklj6', 'cmr45i76f03no117fyzn4f3re', 'cmr45i7ah03o6117f1ved10g4', 'cmr45i7at03oe117f3ozth9qo', 'cmr45i7av03og117fj34tqvou',
  'cmr45i7b303oo117f8hiyk28x', 'cmr45i7ba03ou117f85q488kg', 'cmr45i7bc03ow117f4w1kyp6w', 'cmr45i7bi03p2117fi4lpemp1', 'cmr45i7cd03pq117fd4t2t0ui', 'cmr45i7f303r8117fzwj1ytq5',
  'cmr45i7fu03rm117f9a9pewdk', 'cmr45ilvz04py117finw6r60i', 'cmr45ilw504q2117fs0eb16rb', 'cmr45ilw904q4117fy2wd6lrv', 'cmr45ilwd04q6117fu3z5ufup', 'cmr45ilwj04qa117f11xna1wr',
  'cmr45ilx004qk117fkaenr6a8', 'cmr45ilx804qo117fv4q1omsn', 'cmr45im1i04s6117fp81y3x8x', 'cmr45im6a04ta117flpnhy6mi', 'cmr45invu04uo117f5pl6u5f1', 'cmr45inyj04vc117f9pb6h1tc',
  'cmr45inzz04vq117fqsfbdq76', 'cmr45io0604vs117f19njh6t4', 'cmr45io0d04vu117f9op8h07j', 'cmr45io0j04vw117f8mrov9dc', 'cmr45io1804w2117fscxdc357', 'cmr45io1g04w4117fvbqnvavh',
  'cmr45io1q04w6117f2r9xt343', 'cmr45io1y04w8117f8fv1fa1w', 'cmr45io2804wa117f3nqgeg8y', 'cmr45io3104wg117fnnujewt1', 'cmr45io3a04wi117ffqap9na0', 'cmr45io3l04wk117fsqpqx4qo',
  'cmr45io4c04wo117f0vgbnxnb', 'cmr45io4k04wq117fh6ye0s4y', 'cmr45io5604ww117ffme0nh8z', 'cmr45io6t04xe117fi993eolt', 'cmr45io8x04xw117fsv85emu1', 'cmr45ioa604y6117fz8ho47sy',
  'cmr45iocd04yi117frnavevzq', 'cmr45iock04yk117fnrzznilu', 'cmr45iocr04ym117f6va0duoj', 'cmr45ioef04z4117fo81hnqod', 'cmr45ioen04z6117fze6myepb', 'cmr45iqtx0504117fs82dx9rm',
  'cmr45iqvn050e117f6kocf8zy', 'cmr45iqwc050m117f5l2s4o53', 'cmr45ir4p052k117fdscfxp98', 'cmr45iraw0544117fol6zov4i', 'cmr45irb10546117flfzj90gy', 'cmr45irbh054e117f8nvns0wj',
  'cmr45ivac0556117fathwhfip', 'cmr45ivuf059s117fjx34ih2q', 'cmr45ivuz059w117f7t7jt9p1', 'cmr45ivvp05a2117fyhkefs07', 'cmr45ivw705a8117fqx7tgp1s', 'cmr45ivwq05ac117fllzbvnqh',
  'cmr45iynm05ai117f9tzlfozu', 'cmr45iyob05ao117feurdndzv', 'cmr45iyon05aq117fvw5juqiu', 'cmr45iyp905au117f3lh5ayxl', 'cmr45iypl05aw117ftn4zi6ym', 'cmr45iyru05ba117fwvy4n8iv',
  'cmr45iysy05bk117fdrr9u9u6', 'cmr45iyuk05by117fzwl6w9pl', 'cmr45jkey05pi117f2efzybny', 'cmr45jlz205r2117f8gwb33qw', 'cmr45jncn05vu117ffp7ipd1b', 'cmr45jneh05w8117fzo0epj0n',
  'cmr45jno705yg117frk7oosjs', 'cmr45jnvm060q117fv939kyed', 'cmr45jnwb060w117fzfx1g07d', 'cmr45jp3l0620117ftebnziem', 'cmr459r0q001t117f65xbd3m8', 'cmr45f4tc008s117fki8rbmx9',
  'cmr45f53y00aq117f09zae1j7', 'cmr45f5qp00bo117fa9st2h4t', 'cmr45f5rl00bw117fwhvuglpc', 'cmr45f5um00ci117flr92142w', 'cmr45h1pu00je117fuhjmhd1r', 'cmr45h2eg00ok117fa2wlvzpf',
  'cmr45h3q600rw117f08vpz3ow', 'cmr45h4v400uu117fwcopdltj', 'cmr45h54800wo117fu9ggx4ru', 'cmr45h5hm00yy117f2rz9s9xr', 'cmr45h6yy010m117fkpkai1hs', 'cmr45h8z7019g117fm9azuncm',
  'cmr45hbgd01go117fnux1913k', 'cmr45he0p01mq117fmvr6nuq6', 'cmr45hgam01ru117fl7p4y7u5', 'cmr45hgoh01uy117ff6fj30ys', 'cmr45hi3a01wa117fljj2xzv2', 'cmr45hir5020i117fa8498fgb',
  'cmr45hks1025e117f9qksp8v3', 'cmr45hnv302ck117fsqvi1yt4', 'cmr45hzfg0358117fi0shactq', 'cmr45hzhs036q117fmcptvnwx', 'cmr45i5bq03gy117f3wr2kjeu', 'cmr45i5co03h4117fgf5b39i7',
  'cmr45i5fk03ho117fsk08207n', 'cmr45i5h703hy117fhsbbyt1r', 'cmr45i5j803ia117fjnvxap3w', 'cmr45i5jn03ic117fnhx38wdk', 'cmr45i5kn03ik117fjdkgqfoo', 'cmr45i5nu03ja117f0hoyz37v',
  'cmr45i5pa03jo117fkrcyf9sb', 'cmr45i5tz03kg117fvzie1nzz', 'cmr45i5uv03km117flpwijg36', 'cmr45i5vj03kq117f4vcpl0aw', 'cmr45i72903mq117f4ylcabzn', 'cmr45i73403ne117f1zr2zdnl',
  'cmr45i73603ng117fz0z6724a', 'cmr45i74003ni117fct1m5ur3', 'cmr45i75403nk117fllbjweod', 'cmr45i7bk03p4117fftk90swb', 'cmr45i7bm03p6117f3lw83hjl', 'cmr45i7c203pg117fq29dpa7o',
  'cmr45i7c403pi117f5znrwxm6', 'cmr45i7cl03pw117fw720lpsu', 'cmr45i7cz03q4117fkeweaghc', 'cmr45i7d503q8117f02qt24gh', 'cmr45i7da03qc117f4yvk39yk', 'cmr45i7dd03qe117ff6ddyssj',
  'cmr45i7dg03qg117ffxrfqbfh', 'cmr45i7ec03qw117fq90ai9e7', 'cmr45i7ee03qy117fl3gpsbdy', 'cmr45i7f603ra117frn0ncruq', 'cmr45i7fi03re117fops7dts6', 'cmr45i7fl03rg117fcqq8l3t3',
  'cmr45i7fq03rk117ffxo9qotc', 'cmr45i7g103rq117fik09wbtq', 'cmr45i8ju03ry117f5xzawdsv', 'cmr45i8k203s0117fzqqa48lj', 'cmr45i8kk03s4117ftk579zx5', 'cmr45i8la03sa117f1urfpguk',
  'cmr45i8m603sg117fdu1qiv81', 'cmr45i8mq03sk117fb9iw6o1v', 'cmr45i8ng03so117ft5zpdvu5', 'cmr45i8og03su117fnk5qx3f2', 'cmr45i8oq03sw117f40hhiuny', 'cmr45i8p403sy117fqibig7ko',
  'cmr45i8pi03t0117fkrg5rlvn', 'cmr45i8qf03t4117fnx8e7eg1', 'cmr45i8r503ta117flov9509q', 'cmr45i8s603ti117fojmaxo03', 'cmr45i8sf03tk117fabf4kvrc', 'cmr45i8so03tm117fb7pu6lq3',
  'cmr45i8u403ty117fkf488ixd', 'cmr45i8uj03u2117fwp14bxn5', 'cmr45i8us03u4117fcqemlga3', 'cmr45i8w003ue117fzj3vwtx1', 'cmr45i8w903ug117fyg90klc5', 'cmr45i8wj03ui117fkk11rq05',
  'cmr45i8xx03uq117f9brbxf2m', 'cmr45i8yv03uw117f9nomt968', 'cmr45i8z603uy117faddoryob', 'cmr45i8zh03v0117fmd0dpgs7', 'cmr45i92803vk117fo1rxaldp', 'cmr45i92x03vo117ffwfpi8i6',
  'cmr45i94o03vy117fuyoqfqx1', 'cmr45i95503w2117f3u7o9adu', 'cmr45i95m03w4117fiijk063u', 'cmr45i97703we117f18o70dpl', 'cmr45i97t03wi117fkiyz17t5', 'cmr45i98303wk117fje3psej7',
  'cmr45i99403wq117fcyrg9id2', 'cmr45i99r03wu117fuulwyzea', 'cmr45i9a403wy117f2civvtj4', 'cmr45i9aa03x0117frqvrwelf', 'cmr45i9ba03xa117fucgrb9en', 'cmr45ia5q03xe117fshmmeh90',
  'cmr45ia6203xg117fts2t9kz5', 'cmr45ia6c03xi117f2p0bpi75', 'cmr45ia7003xm117fn9rulefv', 'cmr45ia7i03xq117fm74th8bj', 'cmr45ia7v03xs117f72e8p04h', 'cmr45ia8j03xw117f1nx1ys2u',
  'cmr45ia8u03xy117f9mwrww1t', 'cmr45ia9403y0117fbyob8r9p', 'cmr45iaa103y6117fi8hh4hif', 'cmr45iabs03ye117f1bkg990t', 'cmr45iac303yg117frjct8mdi', 'cmr45ilwx04qi117fncm5okh8',
  'cmr45ily104r0117f29lk7u1w', 'cmr45ilye04r6117f18we5wrc', 'cmr45ilyi04r8117fjam980f3', 'cmr45ilyx04re117fnoa353ah', 'cmr45im1o04s8117ff9pm845m', 'cmr45im2a04se117faw0ik3hu',
  'cmr45intw04u8117fcdj0b1ko', 'cmr45inwz04uy117fhiprs1ft', 'cmr45inxn04v4117fkccyx9a7', 'cmr45inya04va117fxse1hr1e', 'cmr45io6e04xa117fkxnepq4w', 'cmr45io8604xq117f4dwxxkr7',
  'cmr45io9n04y2117fy9c64oqm', 'cmr45ir6e0530117f0rhtjp2a', 'cmr45irb50548117fapuqxydj', 'cmr45irbv054k117figtmbjk2', 'cmr45iyqt05b4117fxmeuihid', 'cmr45iz8605ey117fffan9799',
  'cmr45jift05gs117fqfk5pf9f', 'cmr45jihb05hc117f7utpiocb', 'cmr45jjyc05m6117f1ulenwu4', 'cmr45jkco05p0117ffl0dyrq9', 'cmr45jkfi05pm117fkgon40cd', 'cmr45jlxu05qo117fzh0k3cmw',
  'cmr45jlxz05qq117fb5lk6fol', 'cmr45jlzc05r4117ff0zfhe9e', 'cmr45jm2k05rs117ff3kxslqf', 'cmr45jm3605s0117fhr2vdvm3', 'cmr45jm3o05s4117fu5g600qe', 'cmr45jm6j05su117f9c0esn0j',
  'cmr45jmbg05u8117fjg8pwkkf', 'cmr45jmff05v8117fkxl2r8mk', 'cmr45jnc405vq117fdvaai74k', 'cmr45jnd005vw117fa0u91ze6', 'cmr45jng305wm117fapwvyso0', 'cmr45jnns05ya117f5i20sgdp',
  'cmr45jnra05ze117fhtrqyyzr', 'cmr45jnv0060k117f9fqapwee', 'cmr45jp35061w117fvk1pau0s', 'cmr45jp810636117f2nws8ot4', 'cmr45jpfb0652117fgpyg333n';

-- ── PHASE 0 — VERIFY (read-only). Expect 51 / {REFUND:51} / 0 / 0. ───────────
-- If any actual differs, STOP and re-derive scope before writing.
SELECT count(*) AS payment_not_debtpayment
FROM "Transaction"
WHERE "category" = 'Payment' AND "flowType" IS DISTINCT FROM 'DEBT_PAYMENT';   -- expect 51

SELECT "flowType", count(*)
FROM "Transaction"
WHERE "category" = 'Payment' AND "flowType" IS DISTINCT FROM 'DEBT_PAYMENT'
GROUP BY 1;                                                                     -- expect {REFUND:51}

SELECT count(*) AS fee_spending
FROM "Transaction" WHERE "category" = 'Fee' AND "flowType" = 'SPENDING';        -- expect 0

SELECT count(*) AS transfer_not_transfer
FROM "Transaction" WHERE "category" = 'Transfer' AND "flowType" IS DISTINCT FROM 'TRANSFER'; -- expect 0

-- Sanity: the population view really is 701 rows and every id still exists.
SELECT (SELECT count(*) FROM desync_pop) AS pop_ids,
       (SELECT count(*) FROM "Transaction" t JOIN desync_pop p ON t.id = p.id) AS matched; -- expect 701 / 701

-- ── PHASE 1 — SNAPSHOT (read-only; rollback precondition). ───────────────────
-- Run from psql:  \copy (…) TO 'flow-desync-preimage-2026-07-06.csv' CSV HEADER
-- (kept as a SELECT here so it is also inspectable inline)
SELECT t.id, t."category", t."flowType", t."flowDirection",
       t."classificationConfidence", t."classificationReason", t."classifierVersion"
FROM "Transaction" t JOIN desync_pop p ON t.id = p.id
ORDER BY t.id;

-- ── PHASE 2 — INVALIDATE (THE ONLY WRITE). Requires approval. ────────────────
-- Wrap in a transaction so the row count can be checked before COMMIT.
BEGIN;
UPDATE "Transaction" SET "classifierVersion" = NULL
WHERE id IN (SELECT id FROM desync_pop);
-- Expect: UPDATE 701. If fewer, only proceed if Phase 0 explained why.
-- Inspect, then:   COMMIT;   (or ROLLBACK; to abort — harmless, no flow values changed)
-- COMMIT;

-- ── PHASE 3 — RECLASSIFY (NOT sql) ───────────────────────────────────────────
--   npx tsx scripts/backfill-flowtype.ts            # dry-run must report 701 to classify
--   npx tsx scripts/backfill-flowtype.ts --apply    # idempotent; writes only flow columns

-- ── PHASE 4 — VALIDATE (read-only). All must be 0 / certified. ───────────────
--   npm run audit:flow-desync                       # must print "PASSED … Corpus certified"
--   npx tsx scripts/backfill-flowtype.ts            # dry-run must report 0 to classify
-- And diff the Phase-1 snapshot vs the same SELECT re-run: exactly 51 rows
-- flip REFUND -> DEBT_PAYMENT, 650 identical.
