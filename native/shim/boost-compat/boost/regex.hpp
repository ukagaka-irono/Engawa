// 文 (AYA5) が使う古い Boost.Regex (1.3x の boost::reg_expression) の代わり。C++11 の <regex> で作る。
// engines.mjs で shimIncludes に boost-compat を指定したものだけが読む
#ifndef ENGAWA_BOOST_REGEX_HPP
#define ENGAWA_BOOST_REGEX_HPP
#include <regex>

namespace boost {
template <class charT>
using reg_expression = std::basic_regex<charT>;
template <class BidiIt>
using match_results = std::match_results<BidiIt>;
using std::regex_match;
using std::regex_search;
typedef std::regex_error bad_expression;
}  // namespace boost

#endif
