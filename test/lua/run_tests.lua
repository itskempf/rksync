local function encodeNameSegment(value)
	local bytes = { string.byte(value, 1, #value) }
	local result = {}
	for _, byteValue in ipairs(bytes) do
		local isAlpha = (byteValue >= 65 and byteValue <= 90) or (byteValue >= 97 and byteValue <= 122)
		local isDigit = byteValue >= 48 and byteValue <= 57
		local isSafe = isAlpha or isDigit or byteValue == 45 or byteValue == 95
		if isSafe then
			table.insert(result, string.char(byteValue))
		else
			table.insert(result, string.format("%%%02X", byteValue))
		end
	end

	local encoded = table.concat(result)
    local RESERVED_SEGMENTS = {CON = true, PRN = true, AUX = true, NUL = true,
	COM1 = true, COM2 = true, COM3 = true, COM4 = true, COM5 = true,
	COM6 = true, COM7 = true, COM8 = true, COM9 = true, LPT1 = true,
	LPT2 = true, LPT3 = true, LPT4 = true, LPT5 = true, LPT6 = true,
	LPT7 = true, LPT8 = true, LPT9 = true}
	if encoded == "" or encoded == "." or encoded == ".." or RESERVED_SEGMENTS[string.upper(encoded)] then
		result = {}
		for _, byteValue in ipairs(bytes) do
			table.insert(result, string.format("%%%02X", byteValue))
		end
		encoded = table.concat(result)
        if encoded == "" then
            encoded = "%00"
        end
	end

	return encoded
end

local function decodeNameSegment(segment)
    if segment == "%00" then
        return ""
    end
	return (segment:gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16))
	end))
end

local tests_passed = 0
local tests_failed = 0

local function assert_eq(a, b, msg)
    if a == b then
        tests_passed = tests_passed + 1
    else
        tests_failed = tests_failed + 1
        print("FAIL: " .. msg .. " (Expected: '" .. tostring(b) .. "', Got: '" .. tostring(a) .. "')")
    end
end

-- Test encode
assert_eq(encodeNameSegment("hello"), "hello", "Encode normal string")
assert_eq(encodeNameSegment(""), "%00", "Encode empty string")
assert_eq(encodeNameSegment("CON"), "%43%4F%4E", "Encode reserved word")
assert_eq(encodeNameSegment("con"), "%63%6F%6E", "Encode reserved word lowercase")
assert_eq(encodeNameSegment("A B"), "A%20B", "Encode space")
assert_eq(encodeNameSegment("."), "%2E", "Encode dot")
assert_eq(encodeNameSegment(".."), "%2E%2E", "Encode double dot")

-- Test decode
assert_eq(decodeNameSegment("hello"), "hello", "Decode normal string")
assert_eq(decodeNameSegment("%00"), "", "Decode empty string")
assert_eq(decodeNameSegment("%43%4F%4E"), "CON", "Decode reserved word")
assert_eq(decodeNameSegment("%63%6F%6E"), "con", "Decode reserved word lowercase")
assert_eq(decodeNameSegment("A%20B"), "A B", "Decode space")

print("Tests passed: " .. tests_passed)
print("Tests failed: " .. tests_failed)
if tests_failed > 0 then
    os.exit(1)
end
